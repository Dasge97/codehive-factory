import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { EventBus, listEvents } from './events.js';
import { createAgent, createProject } from './projects.js';
import { createTask, pendingNotices, requireTask, setStatus } from './tasks.js';
import { claimTask } from './queue.js';
import {
  blockingFindings,
  listIncrements,
  openFindings,
  publishIncrement,
  readyToIntegrate,
  resolveFindingsOfFixTask,
} from './review.js';
import type { Agent, Project, Task } from '../shared/types.js';

let db: Db;
let bus: EventBus;
let proyecto: Project;
let builder: Agent;

beforeEach(() => {
  db = openDatabase(':memory:');
  bus = new EventBus();
  proyecto = createProject(db, { name: 'Prueba', repo_path: '/tmp/prueba' });
  builder = createAgent(db, {
    project_id: proyecto.id,
    name: 'Builder',
    role: 'builder',
    engine: 'claude_code',
    instructions: 'construye',
    allowed_tools: ['Read', 'Write'],
  });
  createAgent(db, {
    project_id: proyecto.id,
    name: 'Reviewer',
    role: 'reviewer',
    engine: 'claude_code',
    instructions: 'revisa',
    allowed_tools: ['Read'],
  });
});

/** Deja una tarea de construcción con un incremento publicado y su revisión abierta. */
function tareaConIncremento(): { build: Task; review: Task; incrementId: string } {
  const build = createTask(db, bus, {
    project_id: proyecto.id,
    kind: 'build',
    title: 'Añadir validación de nombres',
    goal: 'Implementar la validación',
    acceptance: 'Los nombres vacíos se rechazan',
    required_role: 'builder',
    created_by: 'creator',
    branch: 'task/uno',
  });

  const claim = claimTask(db, bus, {
    task_id: build.id,
    agent_id: builder.id,
    worker_id: 'w1',
    engine: 'claude_code',
  });

  const publicado = publishIncrement(db, bus, {
    task_id: build.id,
    run_id: claim.run!.id,
    commit_sha: 'a1b2c3d4e5f6',
    branch: 'task/uno',
    message: 'incremento 1',
    files: ['src/validate.ts'],
  });

  setStatus(db, bus, build.id, 'in_review');

  return {
    build: requireTask(db, build.id),
    review: publicado.review_task!,
    incrementId: publicado.increment.id,
  };
}

describe('publicación de un incremento', () => {
  it('guarda el commit y abre una tarea de revisión', () => {
    const { build, review } = tareaConIncremento();

    expect(build.head_commit).toBe('a1b2c3d4e5f6');
    expect(review.kind).toBe('review');
    expect(review.required_role).toBe('reviewer');
    expect(review.parent_task_id).toBe(build.id);
    expect(review.base_commit).toBe('a1b2c3d4e5f6');
  });

  it('la revisión entra con más prioridad que la construcción', () => {
    const { build, review } = tareaConIncremento();
    expect(review.priority).toBeLessThan(build.priority);
  });

  it('publica el evento del incremento', () => {
    tareaConIncremento();
    expect(listEvents(db, proyecto.id).map((e) => e.type)).toContain('increment.published');
  });

  it('revisar un incremento no genera otra revisión en cadena', () => {
    const { review } = tareaConIncremento();
    const claim = claimTask(db, bus, {
      task_id: review.id,
      agent_id: builder.id,
      worker_id: 'w2',
      engine: 'claude_code',
    });
    const segundo = publishIncrement(db, bus, {
      task_id: review.id,
      run_id: claim.run!.id,
      commit_sha: 'ffffff',
      branch: 'task/uno',
      message: 'nota de revisión',
      files: [],
    });
    expect(segundo.review_task).toBeNull();
  });
});

describe('revisión sin hallazgos', () => {
  it('da la tarea por terminada y aprueba el incremento', () => {
    const { build, review, incrementId } = tareaConIncremento();

    openFindings(db, bus, { review_task_id: review.id, increment_id: incrementId, findings: [] });

    expect(requireTask(db, build.id).status).toBe('done');
    expect(listIncrements(db, build.id)[0]!.review_status).toBe('approved');
  });

  it('la tarea queda lista para integrar', () => {
    const { build, review, incrementId } = tareaConIncremento();
    openFindings(db, bus, { review_task_id: review.id, increment_id: incrementId, findings: [] });
    expect(readyToIntegrate(db, build.id).ready).toBe(true);
  });
});

describe('revisión con hallazgos', () => {
  it('un hallazgo bloqueante crea una corrección y devuelve la tarea a la cola', () => {
    const { build, review, incrementId } = tareaConIncremento();

    const resultado = openFindings(db, bus, {
      review_task_id: review.id,
      increment_id: incrementId,
      findings: [
        {
          severity: 'blocker',
          title: 'Acepta la cadena vacía',
          detail: 'La validación deja pasar un nombre vacío.',
          resolution: 'Un nombre vacío devuelve error.',
          file_path: 'src/validate.ts',
          line: 42,
        },
      ],
    });

    expect(resultado.blocking).toBe(true);
    expect(resultado.fix_tasks).toHaveLength(1);

    const correccion = resultado.fix_tasks[0]!;
    expect(correccion.kind).toBe('fix');
    expect(correccion.required_role).toBe('builder');
    expect(correccion.acceptance).toBe('Un nombre vacío devuelve error.');
    expect(correccion.priority).toBe(5);

    expect(requireTask(db, build.id).status).toBe('ready');
    expect(listIncrements(db, build.id)[0]!.review_status).toBe('rejected');
  });

  it('el hallazgo queda vinculado a su corrección', () => {
    const { review, incrementId } = tareaConIncremento();
    const r = openFindings(db, bus, {
      review_task_id: review.id,
      increment_id: incrementId,
      findings: [
        { severity: 'major', title: 'x', detail: 'y', resolution: 'z' },
      ],
    });
    const finding = db.prepare('SELECT * FROM findings WHERE id = ?').get(r.findings[0]!.id) as {
      fix_task_id: string;
    };
    expect(finding.fix_task_id).toBe(r.fix_tasks[0]!.id);
  });

  it('un hallazgo leve se registra pero no crea trabajo', () => {
    const { build, review, incrementId } = tareaConIncremento();
    const r = openFindings(db, bus, {
      review_task_id: review.id,
      increment_id: incrementId,
      findings: [{ severity: 'minor', title: 'nombre poco claro', detail: 'd', resolution: 'r' }],
    });

    expect(r.findings).toHaveLength(1);
    expect(r.fix_tasks).toHaveLength(0);
    expect(requireTask(db, build.id).status).toBe('in_review');
  });

  it('deja un aviso a la tarea original para su siguiente ejecución', () => {
    const { build, review, incrementId } = tareaConIncremento();
    openFindings(db, bus, {
      review_task_id: review.id,
      increment_id: incrementId,
      findings: [{ severity: 'blocker', title: 'fallo', detail: 'd', resolution: 'r' }],
    });
    expect(pendingNotices(db, build.id)[0]!.body).toMatch(/fallo/);
  });

  it('un hallazgo bloqueante impide integrar', () => {
    const { build, review, incrementId } = tareaConIncremento();
    openFindings(db, bus, {
      review_task_id: review.id,
      increment_id: incrementId,
      findings: [{ severity: 'blocker', title: 'fallo', detail: 'd', resolution: 'r' }],
    });
    expect(blockingFindings(db, build.id)).toHaveLength(1);
    expect(readyToIntegrate(db, build.id).ready).toBe(false);
  });
});

describe('corrección de un hallazgo', () => {
  it('al aprobar la corrección el hallazgo queda resuelto', () => {
    const { review, incrementId } = tareaConIncremento();
    const r = openFindings(db, bus, {
      review_task_id: review.id,
      increment_id: incrementId,
      findings: [{ severity: 'blocker', title: 'fallo', detail: 'd', resolution: 'r' }],
    });

    const resueltos = resolveFindingsOfFixTask(db, bus, r.fix_tasks[0]!.id);

    expect(resueltos).toHaveLength(1);
    const finding = db.prepare('SELECT status FROM findings WHERE id = ?').get(r.findings[0]!.id) as {
      status: string;
    };
    expect(finding.status).toBe('fixed');
    expect(listEvents(db, proyecto.id).map((e) => e.type)).toContain('finding.resolved');
  });
});

describe('qué se puede integrar', () => {
  it('una revisión no se integra: se integra la tarea que revisó', () => {
    const { build, review, incrementId } = tareaConIncremento();
    openFindings(db, bus, { review_task_id: review.id, increment_id: incrementId, findings: [] });

    // La revisión termina también, y comparte rama y commit con la tarea original.
    setStatus(db, bus, review.id, 'in_progress');
    setStatus(db, bus, review.id, 'done');

    expect(readyToIntegrate(db, build.id).ready).toBe(true);
    expect(readyToIntegrate(db, review.id).ready).toBe(false);
    expect(readyToIntegrate(db, review.id).reason).toMatch(/no se integra/);
  });
});

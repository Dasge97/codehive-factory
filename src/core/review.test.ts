import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { EventBus, listEvents } from './events.js';
import { createAgent, createProject, updateProject } from './projects.js';
import { createTask, pendingNotices, requireTask, setStatus } from './tasks.js';
import { claimTask } from './queue.js';
import {
  blockingFindings,
  cerrarTrasLimpieza,
  listFindings,
  listIncrements,
  openFindings,
  openSystemFinding,
  publishIncrement,
  readyToIntegrate,
} from './review.js';
import type { Agent, FindingInput, Project, Task } from '../shared/types.js';

let db: Db;
let bus: EventBus;
let proyecto: Project;
let builder: Agent;

beforeEach(() => {
  db = openDatabase(':memory:');
  bus = new EventBus();
  proyecto = createProject(db, { name: 'Prueba', repo_path: '/tmp/prueba', max_task_attempts: 3 });
  builder = createAgent(db, {
    project_id: proyecto.id,
    name: 'Builder',
    role: 'builder',
    engine: 'claude_code',
    instructions: 'construye',
    allowed_tools: ['Read', 'Write'],
  });
  for (const [name, role] of [
    ['Reviewer', 'reviewer'],
    ['Refactorer', 'refactorer'],
  ] as const) {
    createAgent(db, {
      project_id: proyecto.id,
      name,
      role,
      engine: 'claude_code',
      instructions: 'x',
      allowed_tools: ['Read'],
    });
  }
});

const BLOQUEANTE: FindingInput = {
  severity: 'blocker',
  title: 'Acepta la cadena vacía',
  detail: 'La validación deja pasar un nombre vacío.',
  resolution: 'Un nombre vacío devuelve error.',
  file_path: 'src/validate.ts',
  line: 42,
};

/** Publica un incremento de una tarea que está en curso y la deja en revisión. */
function publicar(task: Task, commit: string): { review: Task; incrementId: string } {
  const claim = claimTask(db, bus, {
    task_id: task.id,
    agent_id: builder.id,
    worker_id: 'w1',
    engine: 'claude_code',
  });

  const publicado = publishIncrement(db, bus, {
    task_id: task.id,
    run_id: claim.run!.id,
    commit_sha: commit,
    branch: task.branch ?? 'task/uno',
    message: `incremento ${commit}`,
    files: ['src/validate.ts'],
  });

  db.prepare('UPDATE tasks SET active_run_id = NULL WHERE id = ?').run(task.id);
  setStatus(db, bus, task.id, 'in_review');

  return { review: publicado.review_task!, incrementId: publicado.increment.id };
}

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

  const { review, incrementId } = publicar(build, 'a1b2c3d4e5f6');
  return { build: requireTask(db, build.id), review, incrementId };
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

describe('revisión con hallazgos: la misma tarea vuelve a la cola (D44)', () => {
  it('un hallazgo bloqueante devuelve la tarea a la cola, con prioridad alta y sin crear otra tarea', () => {
    const { build, review, incrementId } = tareaConIncremento();
    const tareasAntes = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;

    const resultado = openFindings(db, bus, {
      review_task_id: review.id,
      increment_id: incrementId,
      findings: [BLOQUEANTE],
    });

    expect(resultado.blocking).toBe(true);
    expect(resultado.reopened).toBe(true);

    const actualizada = requireTask(db, build.id);
    expect(actualizada.status).toBe('ready');
    expect(actualizada.priority).toBe(5);
    // Misma rama: el siguiente intento continúa sobre el trabajo que ya hay.
    expect(actualizada.branch).toBe('task/uno');
    expect(listIncrements(db, build.id)[0]!.review_status).toBe('rejected');

    const tareasDespues = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
    expect(tareasDespues).toBe(tareasAntes);
  });

  it('un hallazgo major también devuelve la tarea, con prioridad media', () => {
    const { build, review, incrementId } = tareaConIncremento();
    openFindings(db, bus, {
      review_task_id: review.id,
      increment_id: incrementId,
      findings: [{ ...BLOQUEANTE, severity: 'major' }],
    });

    const actualizada = requireTask(db, build.id);
    expect(actualizada.status).toBe('ready');
    expect(actualizada.priority).toBe(20);
    expect(blockingFindings(db, build.id)).toHaveLength(0);
  });

  it('un hallazgo leve se registra y el trabajo sigue adelante', () => {
    const { build, review, incrementId } = tareaConIncremento();
    const r = openFindings(db, bus, {
      review_task_id: review.id,
      increment_id: incrementId,
      findings: [{ severity: 'minor', title: 'nombre poco claro', detail: 'd', resolution: 'r' }],
    });

    expect(r.findings).toHaveLength(1);
    expect(r.reopened).toBe(false);
    expect(requireTask(db, build.id).status).toBe('done');
    expect(listIncrements(db, build.id)[0]!.review_status).toBe('approved');
    expect(readyToIntegrate(db, build.id).ready).toBe(true);
  });

  it('deja un aviso a la tarea para su siguiente ejecución', () => {
    const { build, review, incrementId } = tareaConIncremento();
    openFindings(db, bus, { review_task_id: review.id, increment_id: incrementId, findings: [BLOQUEANTE] });
    expect(pendingNotices(db, build.id)[0]!.body).toMatch(/rechazado/);
  });

  it('un hallazgo bloqueante impide integrar', () => {
    const { build, review, incrementId } = tareaConIncremento();
    openFindings(db, bus, { review_task_id: review.id, increment_id: incrementId, findings: [BLOQUEANTE] });
    expect(blockingFindings(db, build.id)).toHaveLength(1);
    expect(readyToIntegrate(db, build.id).ready).toBe(false);
  });

  it('el hallazgo no apunta a ninguna tarea de corrección aparte', () => {
    const { review, incrementId } = tareaConIncremento();
    const r = openFindings(db, bus, { review_task_id: review.id, increment_id: incrementId, findings: [BLOQUEANTE] });
    expect(r.findings[0]!.fix_task_id).toBeNull();
    const correcciones = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'fix'").get() as { n: number };
    expect(correcciones.n).toBe(0);
  });
});

describe('segunda vuelta: el incremento corregido se vuelve a revisar', () => {
  function primeraVueltaRechazada() {
    const { build, review, incrementId } = tareaConIncremento();
    openFindings(db, bus, { review_task_id: review.id, increment_id: incrementId, findings: [BLOQUEANTE] });
    return requireTask(db, build.id);
  }

  it('la aprobación del incremento nuevo resuelve los hallazgos anteriores', () => {
    const build = primeraVueltaRechazada();
    const segunda = publicar(build, 'b2b2b2b2');

    openFindings(db, bus, { review_task_id: segunda.review.id, increment_id: segunda.incrementId, findings: [] });

    expect(requireTask(db, build.id).status).toBe('done');
    expect(requireTask(db, build.id).head_commit).toBe('b2b2b2b2');
    expect(listFindings(db, build.id).map((f) => f.status)).toEqual(['fixed']);
    expect(listEvents(db, proyecto.id).map((e) => e.type)).toContain('finding.resolved');
    expect(readyToIntegrate(db, build.id).ready).toBe(true);
  });

  it('lo que el reviewer vuelve a abrir sigue abierto, y lo demás se da por resuelto', () => {
    const build = primeraVueltaRechazada();
    const segunda = publicar(build, 'b2b2b2b2');

    openFindings(db, bus, {
      review_task_id: segunda.review.id,
      increment_id: segunda.incrementId,
      findings: [{ ...BLOQUEANTE, title: 'Sigue aceptando la cadena vacía' }],
    });

    const hallazgos = listFindings(db, build.id);
    expect(hallazgos.map((f) => [f.title, f.status])).toEqual([
      ['Acepta la cadena vacía', 'fixed'],
      ['Sigue aceptando la cadena vacía', 'open'],
    ]);
    expect(requireTask(db, build.id).status).toBe('ready');
  });

  it('tras agotar las rondas de corrección del proyecto, la tarea se bloquea', () => {
    updateProject(db, proyecto.id, { max_task_attempts: 2 });
    const build = primeraVueltaRechazada();

    const segunda = publicar(build, 'b2b2b2b2');
    openFindings(db, bus, { review_task_id: segunda.review.id, increment_id: segunda.incrementId, findings: [BLOQUEANTE] });

    const actualizada = requireTask(db, build.id);
    expect(actualizada.status).toBe('blocked');
    expect(actualizada.blocked_reason).toMatch(/rechazado 2 incrementos/);
  });
});

describe('hallazgo abierto por el sistema', () => {
  it('sobre una tarea hecha, la devuelve a la cola con un hallazgo bloqueante', () => {
    const { build, review, incrementId } = tareaConIncremento();
    openFindings(db, bus, { review_task_id: review.id, increment_id: incrementId, findings: [] });
    expect(requireTask(db, build.id).status).toBe('done');

    const hallazgo = openSystemFinding(db, bus, {
      task_id: build.id,
      title: 'La integración rompe las verificaciones',
      detail: 'npm test falla tras fusionar.',
      resolution: 'npm test pasa con la rama fusionada.',
    });

    expect(hallazgo.severity).toBe('blocker');
    const actualizada = requireTask(db, build.id);
    expect(actualizada.status).toBe('ready');
    expect(actualizada.priority).toBe(5);
    expect(listIncrements(db, build.id)[0]!.review_status).toBe('rejected');
    expect(pendingNotices(db, build.id).some((n) => /verificaciones/.test(n.body))).toBe(true);
  });
});

describe('modo estricto: la tarea espera a su limpieza (D44)', () => {
  beforeEach(() => {
    updateProject(db, proyecto.id, { mode: 'strict' });
  });

  it('la aprobación abre el refactor y la tarea sigue en revisión, sin ser integrable', () => {
    const { build, review, incrementId } = tareaConIncremento();
    const r = openFindings(db, bus, { review_task_id: review.id, increment_id: incrementId, findings: [] });

    expect(r.refactor_task).not.toBeNull();
    expect(requireTask(db, build.id).status).toBe('in_review');
    expect(readyToIntegrate(db, build.id).ready).toBe(false);
    expect(readyToIntegrate(db, r.refactor_task!.id).ready).toBe(false);
  });

  it('cuando el refactor queda aprobado, la tarea queda hecha con el commit del refactor', () => {
    const { build, review, incrementId } = tareaConIncremento();
    const r = openFindings(db, bus, { review_task_id: review.id, increment_id: incrementId, findings: [] });
    const refactor = r.refactor_task!;

    const limpieza = publicar(requireTask(db, refactor.id), 'c3c3c3c3');
    openFindings(db, bus, { review_task_id: limpieza.review.id, increment_id: limpieza.incrementId, findings: [] });

    expect(requireTask(db, refactor.id).status).toBe('done');
    const raiz = requireTask(db, build.id);
    expect(raiz.status).toBe('done');
    expect(raiz.head_commit).toBe('c3c3c3c3');
    expect(readyToIntegrate(db, build.id).ready).toBe(true);
    expect(readyToIntegrate(db, refactor.id).ready).toBe(false);
  });

  it('un refactor abandonado deja hecha la tarea con el commit que ya tenía aprobado', () => {
    const { build, review, incrementId } = tareaConIncremento();
    const r = openFindings(db, bus, { review_task_id: review.id, increment_id: incrementId, findings: [] });
    const refactor = r.refactor_task!;

    setStatus(db, bus, refactor.id, 'in_progress');
    setStatus(db, bus, refactor.id, 'blocked', 'el proyecto no verificaba antes de empezar');
    cerrarTrasLimpieza(db, bus, refactor.id);

    const raiz = requireTask(db, build.id);
    expect(raiz.status).toBe('done');
    expect(raiz.head_commit).toBe('a1b2c3d4e5f6');
  });

  it('un refactor con hallazgos vuelve a la cola y la tarea sigue esperando', () => {
    const { build, review, incrementId } = tareaConIncremento();
    const r = openFindings(db, bus, { review_task_id: review.id, increment_id: incrementId, findings: [] });
    const refactor = r.refactor_task!;

    const limpieza = publicar(requireTask(db, refactor.id), 'c3c3c3c3');
    openFindings(db, bus, {
      review_task_id: limpieza.review.id,
      increment_id: limpieza.incrementId,
      findings: [{ ...BLOQUEANTE, title: 'La limpieza cambió el comportamiento' }],
    });

    expect(requireTask(db, refactor.id).status).toBe('ready');
    expect(requireTask(db, build.id).status).toBe('in_review');
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

  it('una tarea ya integrada no vuelve a ofrecerse', () => {
    const { build, review, incrementId } = tareaConIncremento();
    openFindings(db, bus, { review_task_id: review.id, increment_id: incrementId, findings: [] });
    db.prepare("UPDATE tasks SET integrated_at = datetime('now') WHERE id = ?").run(build.id);

    expect(readyToIntegrate(db, build.id).ready).toBe(false);
    expect(readyToIntegrate(db, build.id).reason).toMatch(/ya está integrada/);
  });
});

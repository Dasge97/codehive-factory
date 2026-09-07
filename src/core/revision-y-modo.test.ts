import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { EventBus, listEvents } from './events.js';
import { createAgent, createProject, updateProject } from './projects.js';
import { createTask, requireTask } from './tasks.js';
import { claimTask } from './queue.js';
import { openFindings, publishIncrement } from './review.js';
import type { Agent, AgentResult, Project, Task } from '../shared/types.js';

/**
 * Qué se revisa y qué no.
 *
 * En modo normal el orquestador marca cada tarea, y por encima de su decisión hay un
 * suelo que el sistema aplica siempre. En modo estricto se revisa todo y además el
 * trabajo aprobado pasa por el refactorer.
 */

let db: Db;
let bus: EventBus;
let proyecto: Project;
let builder: Agent;

/** Resultado de un agente que terminó bien y cuya verificación pasó. */
const RESULTADO_LIMPIO: AgentResult = {
  outcome: 'completed',
  summary: 'hecho',
  verification: { ran: true, command: 'npm test', passed: true },
  needs: [],
};

beforeEach(() => {
  db = openDatabase(':memory:');
  bus = new EventBus();
  proyecto = createProject(db, {
    name: 'Prueba',
    repo_path: '/tmp/prueba',
    verify_command: 'npm test',
  });

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

/** Publica un incremento de una tarea de construcción y devuelve si se abrió revisión. */
function publicar(opciones: {
  needsReview?: boolean;
  result?: AgentResult | null;
  kind?: Task['kind'];
}): { build: Task; review: Task | null; incrementId: string } {
  const build = createTask(db, bus, {
    project_id: proyecto.id,
    kind: opciones.kind ?? 'build',
    title: 'Añadir validación de nombres',
    goal: 'Implementar la validación',
    required_role: opciones.kind === 'refactor' ? 'refactorer' : 'builder',
    created_by: 'orchestrator',
    branch: 'task/uno',
    needs_review: opciones.needsReview ?? true,
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
    result: opciones.result === undefined ? RESULTADO_LIMPIO : opciones.result,
  });

  return {
    build: requireTask(db, build.id),
    review: publicado.review_task,
    incrementId: publicado.increment.id,
  };
}

describe('el orquestador decide qué se revisa', () => {
  it('una tarea marcada para revisar abre su revisión', () => {
    expect(publicar({ needsReview: true }).review).not.toBeNull();
  });

  it('una tarea marcada como que no hace falta, y verificada, no abre revisión', () => {
    const { review } = publicar({ needsReview: false });
    expect(review).toBeNull();
  });

  it('y deja constancia de por qué no se revisó', () => {
    publicar({ needsReview: false });

    const evento = listEvents(db, proyecto.id).find((e) => e.type === 'review.skipped');
    expect(evento).toBeDefined();
    expect(JSON.parse(evento!.payload)['reason']).toMatch(/verificado/);
  });
});

describe('el suelo que el sistema aplica siempre', () => {
  it('si la verificación no pasó, se revisa aunque el orquestador dijera que no', () => {
    const { review } = publicar({
      needsReview: false,
      result: { ...RESULTADO_LIMPIO, verification: { ran: true, command: 'npm test', passed: false } },
    });
    expect(review).not.toBeNull();
  });

  it('si la verificación no llegó a ejecutarse, se revisa', () => {
    const { review } = publicar({
      needsReview: false,
      result: { ...RESULTADO_LIMPIO, verification: { ran: false } },
    });
    expect(review).not.toBeNull();
  });

  it('si el proyecto no tiene con qué verificarse, se revisa siempre', () => {
    updateProject(db, proyecto.id, { verify_command: null });
    expect(publicar({ needsReview: false }).review).not.toBeNull();
  });

  it('si el agente terminó a medias, se revisa', () => {
    const { review } = publicar({
      needsReview: false,
      result: { ...RESULTADO_LIMPIO, outcome: 'partial' },
    });
    expect(review).not.toBeNull();
  });

  it('si el agente necesitó algo fuera de su alcance, se revisa', () => {
    const { review } = publicar({
      needsReview: false,
      result: { ...RESULTADO_LIMPIO, needs: ['hay que tocar el esquema de la base de datos'] },
    });
    expect(review).not.toBeNull();
  });

  it('sin resultado del agente no se puede comprobar nada, así que se revisa', () => {
    expect(publicar({ needsReview: false, result: null }).review).not.toBeNull();
  });
});

describe('modo estricto', () => {
  beforeEach(() => {
    updateProject(db, proyecto.id, { mode: 'strict' });
  });

  it('se revisa todo, y la marca del orquestador se ignora', () => {
    expect(publicar({ needsReview: false }).review).not.toBeNull();
  });

  it('el trabajo aprobado sigue camino hacia el refactorer', () => {
    const { build, review, incrementId } = publicar({});
    const resultado = openFindings(db, bus, {
      review_task_id: review!.id,
      increment_id: incrementId,
      findings: [],
    });

    expect(resultado.refactor_task).not.toBeNull();
    expect(resultado.refactor_task!.kind).toBe('refactor');
    expect(resultado.refactor_task!.required_role).toBe('refactorer');
    expect(resultado.refactor_task!.parent_task_id).toBe(build.id);
    // Continúa sobre el commit que se acaba de aprobar, no sobre la rama principal.
    expect(resultado.refactor_task!.base_commit).toBe('a1b2c3d4e5f6');
  });

  it('un trabajo con hallazgos no pasa al refactorer: primero se corrige', () => {
    const { review, incrementId } = publicar({});
    const resultado = openFindings(db, bus, {
      review_task_id: review!.id,
      increment_id: incrementId,
      findings: [
        {
          severity: 'major',
          title: 'Falta comprobar el nombre vacío',
          detail: 'Un nombre vacío pasa la validación',
          resolution: 'Un nombre vacío se rechaza',
        },
      ],
    });

    expect(resultado.refactor_task).toBeNull();
  });

  it('un refactor aprobado no abre otro refactor', () => {
    const { review, incrementId } = publicar({ kind: 'refactor' });
    const resultado = openFindings(db, bus, {
      review_task_id: review!.id,
      increment_id: incrementId,
      findings: [],
    });

    expect(resultado.refactor_task).toBeNull();
  });
});

describe('modo normal', () => {
  it('el trabajo aprobado no pasa por el refactorer', () => {
    const { review, incrementId } = publicar({});
    const resultado = openFindings(db, bus, {
      review_task_id: review!.id,
      increment_id: incrementId,
      findings: [],
    });

    expect(resultado.refactor_task).toBeNull();
  });

  it('cambiar de modo no afecta a las tareas que ya estaban creadas', () => {
    // La tarea nace en modo normal, marcada como que no necesita revisión.
    const build = createTask(db, bus, {
      project_id: proyecto.id,
      kind: 'build',
      title: 'Cambiar un texto',
      goal: 'Corregir una errata',
      required_role: 'builder',
      created_by: 'orchestrator',
      needs_review: false,
    });

    expect(requireTask(db, build.id).needs_review).toBe(0);

    // El modo cambia después. La marca de la tarea no se toca.
    updateProject(db, proyecto.id, { mode: 'strict' });
    expect(requireTask(db, build.id).needs_review).toBe(0);
  });
});

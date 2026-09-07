import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { EventBus } from './events.js';
import { createAgent, createProject } from './projects.js';
import { createTask, requireTask, setStatus } from './tasks.js';
import { claimTask } from './queue.js';
import { openFindings, publishIncrement } from './review.js';
import { projectSnapshot, renderOrchestratorPrompt } from './orchestrator.js';
import type { Agent, Project, Task } from '../shared/types.js';

/**
 * Qué se entera el orquestador de lo que hacen los agentes.
 *
 * El orquestador no continúa ninguna sesión: en cada turno recibe el estado del proyecto y
 * decide con lo que ahí ponga. Si lo que escribió un agente al terminar no está en ese
 * estado, el orquestador no puede saber qué se hizo, solo en qué casilla quedó la tarea.
 */

let db: Db;
let bus: EventBus;
let proyecto: Project;
let builder: Agent;

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
  createAgent(db, {
    project_id: proyecto.id,
    name: 'Reviewer',
    role: 'reviewer',
    engine: 'codex',
    instructions: 'revisa',
    allowed_tools: ['Read'],
  });
});

/** Deja una tarea ejecutada, con el resumen que escribió el agente al terminar. */
function tareaEjecutada(
  resumen: string,
  titulo = 'Añadir la validación de nombres',
): { tarea: Task; runId: string } {
  const tarea = createTask(db, bus, {
    project_id: proyecto.id,
    kind: 'build',
    title: titulo,
    goal: 'Implementar la validación',
    required_role: 'builder',
    created_by: 'orchestrator',
    branch: 'task/uno',
  });

  const claim = claimTask(db, bus, {
    task_id: tarea.id,
    agent_id: builder.id,
    worker_id: 'w1',
    engine: 'claude_code',
  });

  db.prepare("UPDATE runs SET summary = ?, status = 'succeeded' WHERE id = ?").run(
    resumen,
    claim.run!.id,
  );

  return { tarea: requireTask(db, tarea.id), runId: claim.run!.id };
}

/** Añade otra ejecución sobre la misma tarea, posterior a las que ya tuviera. */
function otraEjecucion(tarea: Task, resumen: string, segundosDespues: number): void {
  db.prepare(
    `INSERT INTO runs (id, task_id, agent_id, worker_id, engine, status, summary, started_at)
     VALUES (?, ?, ?, 'w2', 'claude_code', 'succeeded', ?, ?)`,
  ).run(
    `run_${segundosDespues}`,
    tarea.id,
    builder.id,
    resumen,
    new Date(Date.now() + segundosDespues * 1000).toISOString(),
  );
}

describe('lo que el agente escribe llega al orquestador', () => {
  it('el resumen de la última ejecución está en el estado del proyecto', () => {
    tareaEjecutada('He añadido la validación y las pruebas pasan. Hizo falta tocar el esquema.');

    const estado = projectSnapshot(db, proyecto.id);
    expect(estado.tasks[0]!.last_result).toContain('las pruebas pasan');
  });

  it('y se le entrega en su encargo, no solo en el estado', () => {
    tareaEjecutada('He añadido la validación y las pruebas pasan.');

    const prompt = renderOrchestratorPrompt(projectSnapshot(db, proyecto.id), '¿Cómo va?');
    expect(prompt).toContain('Dijo el agente: He añadido la validación');
  });

  it('de una tarea con varios intentos llega el último, no el primero', () => {
    const { tarea } = tareaEjecutada('Primer intento: me he quedado a medias.');
    otraEjecucion(tarea, 'Segundo intento: terminado.', 60);

    const estado = projectSnapshot(db, proyecto.id);
    expect(estado.tasks[0]!.last_result).toBe('Segundo intento: terminado.');
  });

  it('un resumen larguísimo se recorta, para no llenar el encargo', () => {
    tareaEjecutada('Una frase larga sobre lo que he hecho. '.repeat(40));

    const resultado = projectSnapshot(db, proyecto.id).tasks[0]!.last_result!;
    expect(resultado.length).toBeLessThan(420);
    expect(resultado.endsWith('…')).toBe(true);
  });

  it('una tarea que no se ha ejecutado no dice nada', () => {
    createTask(db, bus, {
      project_id: proyecto.id,
      kind: 'build',
      title: 'Sin empezar',
      goal: 'x',
      required_role: 'builder',
      created_by: 'orchestrator',
    });

    expect(projectSnapshot(db, proyecto.id).tasks[0]!.last_result).toBeNull();
  });
});

describe('los hallazgos del reviewer llegan con su condición', () => {
  /** Abre un hallazgo sobre una tarea con incremento publicado. */
  function conHallazgo() {
    const { tarea, runId } = tareaEjecutada('He añadido la validación.');

    const publicado = publishIncrement(db, bus, {
      task_id: tarea.id,
      run_id: runId,
      commit_sha: 'a1b2c3d4e5f6',
      branch: 'task/uno',
      message: 'incremento',
      files: ['src/validate.ts'],
    });

    openFindings(db, bus, {
      review_task_id: publicado.review_task!.id,
      increment_id: publicado.increment.id,
      findings: [
        {
          severity: 'major',
          title: 'Acepta la cadena vacía',
          detail: 'Un nombre vacío pasa la validación.',
          resolution: 'Un nombre vacío devuelve error.',
        },
      ],
    });
  }

  it('el hallazgo y lo que hace falta para cerrarlo están en el encargo', () => {
    conHallazgo();

    const estado = projectSnapshot(db, proyecto.id);
    expect(estado.findings).toHaveLength(1);
    expect(estado.findings[0]!.title).toBe('Acepta la cadena vacía');
    expect(estado.findings[0]!.resolution).toBe('Un nombre vacío devuelve error.');

    const prompt = renderOrchestratorPrompt(estado, '¿Qué falta?');
    expect(prompt).toContain('Hallazgos abiertos del reviewer');
    expect(prompt).toContain('Se da por resuelto cuando: Un nombre vacío devuelve error.');
  });

  it('sin hallazgos, el encargo no lleva ese apartado', () => {
    tareaEjecutada('Todo correcto.');

    const prompt = renderOrchestratorPrompt(projectSnapshot(db, proyecto.id), 'hola');
    expect(prompt).not.toContain('Hallazgos abiertos del reviewer');
  });
});

describe('lo que espera a que el creador lo integre', () => {
  it('el orquestador sabe qué hay listo para integrar', () => {
    const { tarea } = tareaEjecutada('He añadido la validación.');
    db.prepare('UPDATE tasks SET head_commit = ? WHERE id = ?').run('a1b2c3d4e5f6', tarea.id);
    setStatus(db, bus, tarea.id, 'in_review');
    setStatus(db, bus, tarea.id, 'done', 'revisión sin hallazgos');

    const estado = projectSnapshot(db, proyecto.id);
    expect(estado.integrable.map((t) => t.id)).toContain(tarea.id);

    const prompt = renderOrchestratorPrompt(estado, 'hola');
    expect(prompt).toContain('espera a que el creador lo integre');
  });

  it('sin nada que integrar, el encargo no lleva ese apartado', () => {
    tareaEjecutada('Todavía a medias.');

    const prompt = renderOrchestratorPrompt(projectSnapshot(db, proyecto.id), 'hola');
    expect(prompt).not.toContain('espera a que el creador lo integre');
  });
});

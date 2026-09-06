import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { EventBus } from './events.js';
import { createAgent, createProject } from './projects.js';
import { createTask, requireTask, setStatus } from './tasks.js';
import {
  abandonRun,
  checkIntegrity,
  claimNext,
  claimTask,
  patronesColisionan,
  queueForRole,
  razonDeEspera,
} from './queue.js';
import type { Agent, Project } from '../shared/types.js';

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
});

function nuevaTarea(extra: Partial<Parameters<typeof createTask>[2]> = {}) {
  return createTask(db, bus, {
    project_id: proyecto.id,
    kind: 'build',
    title: 'Tarea',
    goal: 'Objetivo',
    required_role: 'builder',
    created_by: 'creator',
    ...extra,
  });
}

const worker = (id: string) => ({ agent_id: builder.id, worker_id: id, engine: 'claude_code' as const });

describe('choque de patrones de ruta', () => {
  it('detecta el mismo patrón', () => {
    expect(patronesColisionan('src/core/**', 'src/core/**')).toBe(true);
  });

  it('detecta que un patrón contiene al otro', () => {
    expect(patronesColisionan('src/**', 'src/core/db.ts')).toBe(true);
    expect(patronesColisionan('src/core/**', 'src/**')).toBe(true);
  });

  it('deja pasar ramas distintas del árbol', () => {
    expect(patronesColisionan('src/core/**', 'web/**')).toBe(false);
    expect(patronesColisionan('docs/01.md', 'docs/02.md')).toBe(false);
  });
});

describe('cola', () => {
  it('devuelve solo las tareas del rol pedido', () => {
    nuevaTarea();
    nuevaTarea({ required_role: 'reviewer', kind: 'review' });
    expect(queueForRole(db, proyecto.id, 'builder')).toHaveLength(1);
  });

  it('no devuelve tareas con dependencias abiertas', () => {
    const base = nuevaTarea();
    nuevaTarea({ depends_on: [base.id] });
    expect(queueForRole(db, proyecto.id, 'builder')).toHaveLength(1);
    expect(queueForRole(db, proyecto.id, 'builder')[0]!.task.id).toBe(base.id);
  });

  it('ordena por prioridad', () => {
    nuevaTarea({ title: 'baja', priority: 80 });
    nuevaTarea({ title: 'alta', priority: 5 });
    expect(queueForRole(db, proyecto.id, 'builder').map((e) => e.task.title)).toEqual(['alta', 'baja']);
  });

  it('una tarea vieja adelanta a una nueva de la misma prioridad', () => {
    const vieja = nuevaTarea({ title: 'vieja', priority: 50 });
    const nueva = nuevaTarea({ title: 'nueva', priority: 50 });

    // Se envejece la tarea diez horas tocando su fecha de actualización.
    db.prepare("UPDATE tasks SET updated_at = datetime('now','-10 hours') WHERE id = ?").run(vieja.id);

    const cola = queueForRole(db, proyecto.id, 'builder');
    expect(cola[0]!.task.title).toBe('vieja');
    expect(cola[0]!.priority_efectiva).toBeLessThan(50);
    expect(cola.find((e) => e.task.id === nueva.id)!.priority_efectiva).toBe(50);
  });
});

describe('reclamación atómica', () => {
  it('un worker se queda con la tarea', () => {
    const t = nuevaTarea();
    const r = claimTask(db, bus, { task_id: t.id, ...worker('w1') });
    expect(r.claimed).toBe(true);
    expect(requireTask(db, t.id).status).toBe('in_progress');
    expect(requireTask(db, t.id).active_run_id).toBe(r.run!.id);
    expect(requireTask(db, t.id).attempts).toBe(1);
  });

  it('dos workers a la vez: solo uno se queda con la tarea', () => {
    const t = nuevaTarea();
    const primero = claimTask(db, bus, { task_id: t.id, ...worker('w1') });
    const segundo = claimTask(db, bus, { task_id: t.id, ...worker('w2') });

    expect(primero.claimed).toBe(true);
    expect(segundo.claimed).toBe(false);
    expect(segundo.reason).toMatch(/otro worker/i);

    const ejecuciones = db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND status = 'running'")
      .get(t.id) as { n: number };
    expect(ejecuciones.n).toBe(1);
  });

  it('cada worker se lleva una tarea distinta', () => {
    nuevaTarea({ title: 'A', priority: 10 });
    nuevaTarea({ title: 'B', priority: 20 });

    const a = claimNext(db, bus, proyecto.id, 'builder', worker('w1'));
    const b = claimNext(db, bus, proyecto.id, 'builder', worker('w2'));

    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
    expect(a.task!.id).not.toBe(b.task!.id);
  });

  it('no se puede reclamar una tarea que no está lista', () => {
    const base = nuevaTarea();
    const dependiente = nuevaTarea({ depends_on: [base.id] });
    const r = claimTask(db, bus, { task_id: dependiente.id, ...worker('w1') });
    expect(r.claimed).toBe(false);
    expect(r.reason).toMatch(/espera a que terminen/i);
  });
});

describe('bloqueos de recursos', () => {
  it('una tarea reserva sus ficheros al ser reclamada, no al crearse', () => {
    const a = nuevaTarea({ title: 'A', path_patterns: ['src/core/**'] });
    const b = nuevaTarea({ title: 'B', path_patterns: ['src/core/**'] });

    // Antes de reclamar nada, las dos están disponibles.
    expect(queueForRole(db, proyecto.id, 'builder')).toHaveLength(2);

    claimTask(db, bus, { task_id: a.id, ...worker('w1') });

    const cola = queueForRole(db, proyecto.id, 'builder');
    expect(cola).toHaveLength(0);
    expect(razonDeEspera(db, b.id)).toMatch(/reservados/i);
  });

  it('cerrar la tarea libera sus ficheros y la otra queda disponible', () => {
    const a = nuevaTarea({ title: 'A', path_patterns: ['src/core/**'] });
    const b = nuevaTarea({ title: 'B', path_patterns: ['src/core/**'] });

    claimTask(db, bus, { task_id: a.id, ...worker('w1') });
    setStatus(db, bus, a.id, 'done');

    expect(queueForRole(db, proyecto.id, 'builder').map((e) => e.task.id)).toEqual([b.id]);
  });

  it('dos tareas sobre ramas distintas del árbol conviven', () => {
    nuevaTarea({ title: 'A', path_patterns: ['src/core/**'] });
    const b = nuevaTarea({ title: 'B', path_patterns: ['web/**'] });

    claimNext(db, bus, proyecto.id, 'builder', worker('w1'));
    expect(queueForRole(db, proyecto.id, 'builder').map((e) => e.task.id)).toEqual([b.id]);
  });
});

describe('integridad', () => {
  it('no encuentra problemas en un estado normal', () => {
    const t = nuevaTarea();
    claimTask(db, bus, { task_id: t.id, ...worker('w1') });
    expect(checkIntegrity(db, proyecto.id)).toEqual([]);
  });

  it('detecta una tarea en curso cuya ejecución ya no está activa', () => {
    const t = nuevaTarea();
    const r = claimTask(db, bus, { task_id: t.id, ...worker('w1') });
    db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(r.run!.id);
    expect(checkIntegrity(db, proyecto.id)[0]).toMatch(/no tiene una ejecución activa/);
  });
});

describe('abandono de una ejecución', () => {
  it('devuelve la tarea a la cola', () => {
    const t = nuevaTarea();
    const r = claimTask(db, bus, { task_id: t.id, ...worker('w1') });

    abandonRun(db, bus, r.run!.id, 'el proceso principal se reinició');

    expect(requireTask(db, t.id).status).toBe('ready');
    expect(requireTask(db, t.id).active_run_id).toBeNull();
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(r.run!.id) as { status: string };
    expect(run.status).toBe('interrupted');
  });

  it('otro worker puede reclamarla después', () => {
    const t = nuevaTarea();
    const r = claimTask(db, bus, { task_id: t.id, ...worker('w1') });
    abandonRun(db, bus, r.run!.id, 'worker perdido');

    const segundo = claimTask(db, bus, { task_id: t.id, ...worker('w2') });
    expect(segundo.claimed).toBe(true);
    expect(requireTask(db, t.id).attempts).toBe(2);
  });
});

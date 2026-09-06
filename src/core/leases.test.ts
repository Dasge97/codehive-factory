import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { EventBus, listEvents } from './events.js';
import { createAgent, createProject } from './projects.js';
import { createTask, requireTask, setStatus } from './tasks.js';
import { claimTask } from './queue.js';
import { publishIncrement } from './review.js';
import { getLease, isRunCurrent, reclaimExpiredLeases, recordStaleResult, renewLease } from './leases.js';
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
    project_id: proyecto.id, name: 'Builder', role: 'builder', engine: 'claude_code',
    instructions: 'construye', allowed_tools: ['Read', 'Write'], max_workers: 2,
  });
  createAgent(db, {
    project_id: proyecto.id, name: 'Reviewer', role: 'reviewer', engine: 'claude_code',
    instructions: 'revisa', allowed_tools: ['Read'],
  });
});

function nuevaTarea(extra: Partial<Parameters<typeof createTask>[2]> = {}): Task {
  return createTask(db, bus, {
    project_id: proyecto.id, kind: 'build', title: 'Tarea', goal: 'Objetivo',
    required_role: 'builder', created_by: 'creator', branch: 'task/uno', ...extra,
  });
}

const worker = (id: string) => ({ agent_id: builder.id, worker_id: id, engine: 'claude_code' as const });

/** Adelanta el reloj de una vigencia poniéndola ya caducada. */
function caducarVigencia(taskId: string): void {
  db.prepare("UPDATE leases SET expires_at = datetime('now','-1 minute') WHERE task_id = ?").run(taskId);
}

describe('vigencia de una asignación', () => {
  it('reclamar una tarea le da vigencia', () => {
    const t = nuevaTarea();
    const claim = claimTask(db, bus, { task_id: t.id, ...worker('w1') });

    const vigencia = getLease(db, t.id);
    expect(vigencia).toBeDefined();
    expect(vigencia!.run_id).toBe(claim.run!.id);
    expect(vigencia!.worker_id).toBe('w1');
    expect(new Date(vigencia!.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('renovar alarga la caducidad', () => {
    const t = nuevaTarea();
    const claim = claimTask(db, bus, { task_id: t.id, ...worker('w1') });
    const primera = getLease(db, t.id)!.expires_at;

    renewLease(db, t.id, claim.run!.id, 'w1', 600_000);
    expect(new Date(getLease(db, t.id)!.expires_at).getTime()).toBeGreaterThan(
      new Date(primera).getTime(),
    );
  });

  it('una vigencia al día no se toca', () => {
    const t = nuevaTarea();
    claimTask(db, bus, { task_id: t.id, ...worker('w1') });

    expect(reclaimExpiredLeases(db, bus, proyecto.id)).toEqual([]);
    expect(requireTask(db, t.id).status).toBe('in_progress');
  });
});

describe('P2-02 · un worker caído se detecta y su tarea se reasigna', () => {
  it('la tarea vuelve a la cola y otro worker puede tomarla', () => {
    const t = nuevaTarea();
    const claim = claimTask(db, bus, { task_id: t.id, ...worker('w1') });
    caducarVigencia(t.id);

    const recuperadas = reclaimExpiredLeases(db, bus, proyecto.id);

    expect(recuperadas).toHaveLength(1);
    expect(recuperadas[0]!.worker_id).toBe('w1');
    expect(recuperadas[0]!.had_increment).toBe(false);

    const actualizada = requireTask(db, t.id);
    expect(actualizada.status).toBe('ready');
    expect(actualizada.active_run_id).toBeNull();
    expect(getLease(db, t.id)).toBeUndefined();

    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(claim.run!.id) as {
      status: string; error: string;
    };
    expect(run.status).toBe('interrupted');
    expect(run.error).toMatch(/dejó de dar señales/);

    // Otro worker la reclama sin problema.
    expect(claimTask(db, bus, { task_id: t.id, ...worker('w2') }).claimed).toBe(true);
  });

  it('si el worker perdido ya había publicado, su trabajo no se tira', () => {
    const t = nuevaTarea();
    const claim = claimTask(db, bus, { task_id: t.id, ...worker('w1') });

    publishIncrement(db, bus, {
      task_id: t.id, run_id: claim.run!.id, commit_sha: 'abc1234',
      branch: 'task/uno', message: 'incremento del worker perdido', files: ['a.ts'],
    });

    caducarVigencia(t.id);
    const recuperadas = reclaimExpiredLeases(db, bus, proyecto.id);

    expect(recuperadas[0]!.had_increment).toBe(true);
    // Pasa a revisión en vez de volver a construirse desde cero.
    expect(requireTask(db, t.id).status).toBe('in_review');
  });

  it('no toca una tarea que ya cambió de ejecución', () => {
    const t = nuevaTarea();
    claimTask(db, bus, { task_id: t.id, ...worker('w1') });
    caducarVigencia(t.id);

    // Otro worker se hizo cargo antes del barrido.
    db.prepare("UPDATE tasks SET active_run_id = 'run_otro' WHERE id = ?").run(t.id);

    expect(reclaimExpiredLeases(db, bus, proyecto.id)).toEqual([]);
    expect(requireTask(db, t.id).active_run_id).toBe('run_otro');
  });

  it('deja constancia en los eventos', () => {
    const t = nuevaTarea();
    claimTask(db, bus, { task_id: t.id, ...worker('w1') });
    caducarVigencia(t.id);
    reclaimExpiredLeases(db, bus, proyecto.id);

    const eventos = listEvents(db, proyecto.id).filter((e) => e.type === 'run.finished');
    expect(eventos).toHaveLength(1);
    expect(JSON.parse(eventos[0]!.payload).reason).toBe('worker perdido');
  });
});

describe('P2-03 · un resultado tardío no sobrescribe el estado vigente', () => {
  it('la ejecución sustituida deja de ser la vigente', () => {
    const t = nuevaTarea();
    const primera = claimTask(db, bus, { task_id: t.id, ...worker('w1') });
    expect(isRunCurrent(db, primera.run!.id)).toBe(true);

    caducarVigencia(t.id);
    reclaimExpiredLeases(db, bus, proyecto.id);

    const segunda = claimTask(db, bus, { task_id: t.id, ...worker('w2') });

    expect(isRunCurrent(db, primera.run!.id)).toBe(false);
    expect(isRunCurrent(db, segunda.run!.id)).toBe(true);
  });

  it('el resultado tardío se registra como descartado y no cambia nada', () => {
    const t = nuevaTarea();
    const primera = claimTask(db, bus, { task_id: t.id, ...worker('w1') });
    caducarVigencia(t.id);
    reclaimExpiredLeases(db, bus, proyecto.id);
    const segunda = claimTask(db, bus, { task_id: t.id, ...worker('w2') });

    const estadoAntes = requireTask(db, t.id);

    recordStaleResult(db, bus, primera.run!.id, 'Terminé, pero llego tarde.');

    const estadoDespues = requireTask(db, t.id);
    expect(estadoDespues.status).toBe(estadoAntes.status);
    expect(estadoDespues.active_run_id).toBe(segunda.run!.id);

    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(primera.run!.id) as {
      status: string; error: string; summary: string;
    };
    expect(run.status).toBe('interrupted');
    expect(run.error).toMatch(/se descartó/);
    // El resumen se guarda para poder mirarlo, aunque no se aplique.
    expect(run.summary).toBe('Terminé, pero llego tarde.');
  });

  it('un resultado tardío no crea un incremento duplicado', () => {
    const t = nuevaTarea();
    const primera = claimTask(db, bus, { task_id: t.id, ...worker('w1') });
    caducarVigencia(t.id);
    reclaimExpiredLeases(db, bus, proyecto.id);
    claimTask(db, bus, { task_id: t.id, ...worker('w2') });

    recordStaleResult(db, bus, primera.run!.id, 'resumen tardío');

    const incrementos = db.prepare('SELECT COUNT(*) AS n FROM increments').get() as { n: number };
    expect(incrementos.n).toBe(0);
  });
});

describe('la vigencia se suelta al terminar', () => {
  it('cerrar una tarea deja su vigencia sin efecto', () => {
    const t = nuevaTarea();
    claimTask(db, bus, { task_id: t.id, ...worker('w1') });
    setStatus(db, bus, t.id, 'done');

    caducarVigencia(t.id);
    // Una tarea cerrada no vuelve a la cola por una vigencia caducada.
    reclaimExpiredLeases(db, bus, proyecto.id);
    expect(requireTask(db, t.id).status).toBe('done');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../core/db.js';
import { EventBus } from '../core/events.js';
import { createAgent, createProject } from '../core/projects.js';
import { createTask, requireTask } from '../core/tasks.js';
import { claimTask } from '../core/queue.js';
import { FakeEngine, resultadoDeAgente } from '../engines/fake-engine.js';
import { Supervisor, recoverInterruptedRuns } from './supervisor.js';
import { git } from './git.js';
import type { Project, Task } from '../shared/types.js';

let db: Db;
let bus: EventBus;
let repo: string;
let workspaces: string;
let proyecto: Project;
let supervisor: Supervisor | null = null;

beforeEach(async () => {
  db = openDatabase(':memory:');
  bus = new EventBus();

  repo = mkdtempSync(join(tmpdir(), 'chf-sup-'));
  workspaces = mkdtempSync(join(tmpdir(), 'chf-supws-'));
  process.env['CODEHIVE_WORKSPACES'] = workspaces;

  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'prueba@ejemplo.test']);
  await git(repo, ['config', 'user.name', 'Prueba']);
  writeFileSync(join(repo, 'inicial.txt'), 'contenido\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'commit inicial']);

  proyecto = createProject(db, { name: 'Prueba', repo_path: repo, max_concurrent_runs: 2 });
  for (const role of ['builder', 'reviewer'] as const) {
    createAgent(db, {
      project_id: proyecto.id, name: role, role, engine: 'claude_code',
      instructions: 'trabaja', allowed_tools: ['Read', 'Write'],
    });
  }
});

afterEach(async () => {
  await supervisor?.stop();
  supervisor = null;
  db.close();
  delete process.env['CODEHIVE_WORKSPACES'];
  rmSync(repo, { recursive: true, force: true });
  rmSync(workspaces, { recursive: true, force: true });
});

function nuevaTarea(extra: Partial<Parameters<typeof createTask>[2]> = {}): Task {
  return createTask(db, bus, {
    project_id: proyecto.id, kind: 'build', title: 'Tarea', goal: 'Objetivo',
    required_role: 'builder', created_by: 'creator', ...extra,
  });
}

/** Espera a que una condición se cumpla, o falla al agotarse el tiempo. */
async function esperar(cumple: () => boolean, msMaximo = 8000): Promise<void> {
  const limite = Date.now() + msMaximo;
  while (!cumple()) {
    if (Date.now() > limite) throw new Error('La condición no se cumplió a tiempo.');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('cuándo arranca trabajo el supervisor', () => {
  it('con la cola vacía no arranca ningún worker', async () => {
    supervisor = new Supervisor(db, bus, proyecto.id, new FakeEngine(), { intervalMs: 30 });
    supervisor.start();

    await new Promise((r) => setTimeout(r, 300));

    expect(supervisor.activeWork()).toHaveLength(0);
    const ejecuciones = db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
    expect(ejecuciones.n).toBe(0);
  });

  it('con una tarea en cola arranca un worker y la lleva hasta el final', async () => {
    nuevaTarea();
    supervisor = new Supervisor(db, bus, proyecto.id, new FakeEngine({ resultText: resultadoDeAgente() }), {
      intervalMs: 30,
    });
    supervisor.start();

    await esperar(() => {
      const n = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'succeeded'").get() as { n: number };
      return n.n === 1;
    });

    // Al terminar, el worker se libera.
    await esperar(() => supervisor!.activeWork().length === 0);
  });
});

describe('P1-10 · falta de cuota', () => {
  it('el supervisor deja de arrancar workers y las tareas conservan su estado', async () => {
    nuevaTarea();

    db.prepare(
      `INSERT INTO engine_usage (engine, status, using_overage, updated_at)
       VALUES ('claude_code', 'exhausted', 0, datetime('now'))`,
    ).run();

    supervisor = new Supervisor(db, bus, proyecto.id, new FakeEngine({ resultText: resultadoDeAgente() }), {
      intervalMs: 30,
    });
    supervisor.start();

    await new Promise((r) => setTimeout(r, 400));

    // Sin cuota no se ejecuta nada, y la tarea sigue lista para cuando vuelva.
    expect(supervisor.activeWork()).toHaveLength(0);
    const ejecuciones = db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
    expect(ejecuciones.n).toBe(0);

    const tarea = db.prepare('SELECT * FROM tasks LIMIT 1').get() as Task;
    expect(tarea.status).toBe('ready');
    expect(tarea.attempts).toBe(0);
  });

  it('al volver la cuota el trabajo se reanuda solo', async () => {
    nuevaTarea();
    db.prepare(
      `INSERT INTO engine_usage (engine, status, using_overage, updated_at)
       VALUES ('claude_code', 'exhausted', 0, datetime('now'))`,
    ).run();

    supervisor = new Supervisor(db, bus, proyecto.id, new FakeEngine({ resultText: resultadoDeAgente() }), {
      intervalMs: 30,
    });
    supervisor.start();
    await new Promise((r) => setTimeout(r, 200));

    db.prepare("UPDATE engine_usage SET status = 'allowed' WHERE engine = 'claude_code'").run();

    await esperar(() => {
      const n = db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
      return n.n > 0;
    });
  });
});

describe('P1-05 · recuperación tras un reinicio', () => {
  it('las ejecuciones que figuraban en marcha vuelven a la cola', () => {
    const t = nuevaTarea();
    const builder = db.prepare("SELECT id FROM agents WHERE role = 'builder'").get() as { id: string };

    const claim = claimTask(db, bus, {
      task_id: t.id, agent_id: builder.id, worker_id: 'w1', engine: 'claude_code',
    });
    expect(requireTask(db, t.id).status).toBe('in_progress');

    // El proceso principal muere y vuelve a arrancar.
    const recuperadas = recoverInterruptedRuns(db, bus, proyecto.id);

    expect(recuperadas).toBe(1);
    const actualizada = requireTask(db, t.id);
    expect(actualizada.status).toBe('ready');
    expect(actualizada.active_run_id).toBeNull();

    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(claim.run!.id) as {
      status: string; error: string;
    };
    expect(run.status).toBe('interrupted');
    expect(run.error).toMatch(/se reinició/);
  });

  it('no toca las tareas que ya estaban terminadas', () => {
    const t = nuevaTarea();
    const builder = db.prepare("SELECT id FROM agents WHERE role = 'builder'").get() as { id: string };
    claimTask(db, bus, { task_id: t.id, agent_id: builder.id, worker_id: 'w1', engine: 'claude_code' });
    db.prepare("UPDATE runs SET status = 'succeeded' WHERE task_id = ?").run(t.id);

    expect(recoverInterruptedRuns(db, bus, proyecto.id)).toBe(0);
  });
});

describe('parada del supervisor', () => {
  it('espera a que termine el trabajo en vuelo antes de devolver el control', async () => {
    nuevaTarea();

    // El motor tarda un poco, para que la parada llegue con trabajo en marcha.
    const motor = new FakeEngine({ resultText: resultadoDeAgente() }, async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    supervisor = new Supervisor(db, bus, proyecto.id, motor, { intervalMs: 30 });
    supervisor.start();

    await esperar(() => supervisor!.activeWork().length === 1);
    await supervisor.stop();

    // Al volver de stop no queda nada en vuelo, así que cerrar la base es seguro.
    expect(supervisor.activeWork()).toHaveLength(0);
    const enMarcha = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get() as { n: number };
    expect(enMarcha.n).toBe(0);
  });
});

describe('P1-01 · dos tareas independientes avanzan a la vez', () => {
  it('cada una en su worktree y su rama, con ejecuciones solapadas', async () => {
    // Dos builders, para que puedan trabajar al mismo tiempo.
    createAgent(db, {
      project_id: proyecto.id, name: 'Builder 2', role: 'builder', engine: 'claude_code',
      instructions: 'construye', allowed_tools: ['Read', 'Write'],
    });
    db.prepare("UPDATE agents SET max_workers = 2 WHERE role = 'builder'").run();

    const a = nuevaTarea({ title: 'Tarea A', path_patterns: ['src/a/**'] });
    const b = nuevaTarea({ title: 'Tarea B', path_patterns: ['src/b/**'] });

    const solapadas: string[] = [];

    // Cada ejecución escribe un fichero distinto y tarda lo bastante para solaparse.
    const motor = new FakeEngine({ resultText: resultadoDeAgente() }, async (req) => {
      solapadas.push(req.cwd);
      writeFileSync(join(req.cwd, 'trabajo.txt'), req.cwd);
      await new Promise((r) => setTimeout(r, 250));
    });

    supervisor = new Supervisor(db, bus, proyecto.id, motor, { intervalMs: 30 });
    supervisor.start();

    // Las dos están en marcha al mismo tiempo.
    await esperar(() => supervisor!.activeWork().length === 2);
    const enMarcha = supervisor.activeWork().map((t) => t.task_id).sort();
    expect(enMarcha).toEqual([a.id, b.id].sort());

    await esperar(() => {
      const n = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'succeeded'").get() as { n: number };
      return n.n === 2;
    }, 15000);

    // Dos worktrees distintos y dos ramas distintas. Se filtran los directorios que no
    // son worktrees: las revisiones trabajan sobre el propio repositorio.
    const worktreesUsados = new Set(solapadas.filter((ruta) => ruta.startsWith(workspaces)));
    expect(worktreesUsados.size).toBe(2);
    const ramas = db
      .prepare('SELECT branch FROM tasks WHERE id IN (?, ?)')
      .all(a.id, b.id) as Array<{ branch: string }>;
    expect(new Set(ramas.map((r) => r.branch)).size).toBe(2);

    // Y dos incrementos separados, uno por cada tarea de construcción.
    const incrementos = db
      .prepare('SELECT task_id, commit_sha FROM increments WHERE task_id IN (?, ?)')
      .all(a.id, b.id) as Array<{ task_id: string; commit_sha: string }>;
    expect(incrementos).toHaveLength(2);
    expect(new Set(incrementos.map((i) => i.commit_sha)).size).toBe(2);
  }, 30000);
});

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase, applyMigrations } from './db.js';
import { MIGRATIONS } from './migrations.js';

describe('base de datos', () => {
  it('crea todas las tablas del esquema', () => {
    const db = openDatabase(':memory:');
    const tablas = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);

    for (const esperada of [
      'agents', 'approvals', 'chat_messages', 'decisions', 'engine_usage', 'events',
      'findings', 'increments', 'notices', 'projects', 'resource_locks', 'runs',
      'schema_migrations', 'task_dependencies', 'tasks',
    ]) {
      expect(tablas, `falta la tabla ${esperada}`).toContain(esperada);
    }
    db.close();
  });

  it('no repite una migración ya aplicada', () => {
    const db = openDatabase(':memory:');
    expect(applyMigrations(db)).toEqual([]);
    db.close();
  });

  it('comprueba las referencias entre tablas', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      db.prepare(
        `INSERT INTO agents (id, project_id, name, role, engine, instructions, allowed_tools, created_at, updated_at)
         VALUES ('agt_x','prj_no_existe','x','builder','claude_code','','[]','2026-01-01','2026-01-01')`,
      ).run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('rechaza un estado de tarea que no existe', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO projects (id, name, repo_path, main_branch, max_concurrent_runs, max_task_attempts, run_timeout_ms, status, created_at, updated_at)
       VALUES ('prj_1','p','/tmp/p','main',4,3,900000,'active','2026-01-01','2026-01-01')`,
    ).run();

    expect(() =>
      db.prepare(
        `INSERT INTO tasks (id, project_id, kind, title, goal, required_role, priority, status, created_by, created_at, updated_at)
         VALUES ('tsk_1','prj_1','build','t','g','builder',50,'inventado','creator','2026-01-01','2026-01-01')`,
      ).run(),
    ).toThrow(/CHECK constraint/i);
    db.close();
  });
});

/**
 * La migración 3 recrea las tablas `agents` y `tasks` para ampliar los roles válidos.
 *
 * Recrear una tabla en SQLite significa borrarla. Si las claves foráneas están activas,
 * ese borrado arrastra en cascada las filas de todas las tablas que apuntaban a ella, y
 * lo hace sin dar ningún error. Estas pruebas existen porque la primera versión de la
 * migración se llevó por delante todas las tareas sin quejarse.
 */
describe('la migración que amplía los roles conserva los datos', () => {
  /** Base de datos con el esquema anterior a la migración 3 y con datos dentro. */
  function baseAnterior() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    for (const migration of MIGRATIONS.filter((m) => m.version < 3)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        '2026-01-01T00:00:00.000Z',
      );
    }

    db.exec(`
      INSERT INTO projects (id, name, repo_path, main_branch, max_concurrent_runs, max_task_attempts, run_timeout_ms, status, created_at, updated_at)
      VALUES ('prj_1','p','/tmp/p','main',4,3,900000,'active','2026-01-01','2026-01-01');

      INSERT INTO agents (id, project_id, name, role, engine, instructions, allowed_tools, created_at, updated_at)
      VALUES ('agt_1','prj_1','Builder','builder','claude_code','instrucciones','["Read"]','2026-01-01','2026-01-01');

      INSERT INTO tasks (id, project_id, kind, title, goal, required_role, priority, status, assigned_agent_id, created_by, created_at, updated_at)
      VALUES ('tsk_1','prj_1','build','t','g','builder',50,'in_progress','agt_1','creator','2026-01-01','2026-01-01');

      INSERT INTO tasks (id, project_id, parent_task_id, kind, title, goal, required_role, priority, status, created_by, created_at, updated_at)
      VALUES ('tsk_2','prj_1','tsk_1','review','r','g','reviewer',45,'ready','system','2026-01-01','2026-01-01');

      INSERT INTO runs (id, task_id, agent_id, worker_id, engine, status, started_at)
      VALUES ('run_1','tsk_1','agt_1','wrk_1','claude_code','succeeded','2026-01-01');

      INSERT INTO resource_locks (id, project_id, task_id, path_pattern, acquired_at)
      VALUES ('lck_1','prj_1','tsk_1','src/**','2026-01-01');
    `);

    return db;
  }

  it('los proyectos que ya existían quedan aislados y sin ficheros protegidos', () => {
    const db = baseAnterior();
    applyMigrations(db);

    const proyecto = db.prepare('SELECT * FROM projects WHERE id = ?').get('prj_1') as Record<string, unknown>;
    expect(proyecto['protected_paths']).toBe('[]');
    // Aislado por omisión: un proyecto que ya existía no debe empezar a heredar la
    // configuración personal de quien arranque el sistema sin que nadie lo haya pedido.
    expect(proyecto['use_personal_config']).toBe(0);
  });

  it('deja intactas las tareas, las ejecuciones y los bloqueos', () => {
    const db = baseAnterior();
    // Se aplican todas las que faltaban, sean las que sean: la prueba es sobre los datos,
    // no sobre cuántas migraciones hay.
    expect(applyMigrations(db)).toEqual(
      MIGRATIONS.filter((m) => m.version >= 3).map((m) => m.version),
    );

    const cuenta = (tabla: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get() as { n: number }).n;

    expect(cuenta('tasks')).toBe(2);
    expect(cuenta('agents')).toBe(1);
    expect(cuenta('runs')).toBe(1);
    expect(cuenta('resource_locks')).toBe(1);

    // Los datos de cada fila siguen siendo los mismos, no solo el número de filas.
    const tarea = db.prepare('SELECT * FROM tasks WHERE id = ?').get('tsk_1') as Record<string, unknown>;
    expect(tarea['title']).toBe('t');
    expect(tarea['assigned_agent_id']).toBe('agt_1');
    expect(tarea['status']).toBe('in_progress');

    db.close();
  });

  it('las tareas que ya existían se siguen revisando', () => {
    const db = baseAnterior();
    applyMigrations(db);

    const tarea = db.prepare('SELECT needs_review FROM tasks WHERE id = ?').get('tsk_1') as {
      needs_review: number;
    };
    expect(tarea.needs_review).toBe(1);
    db.close();
  });

  it('deja las claves foráneas como estaban y sin referencias rotas', () => {
    const db = baseAnterior();
    applyMigrations(db);

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // Y siguen comprobándose de verdad, no solo según el pragma.
    expect(() =>
      db.prepare(
        `INSERT INTO tasks (id, project_id, kind, title, goal, required_role, priority, status, created_by, created_at, updated_at)
         VALUES ('tsk_x','prj_no_existe','build','t','g','builder',50,'ready','creator','2026-01-01','2026-01-01')`,
      ).run(),
    ).toThrow(/FOREIGN KEY/i);

    db.close();
  });

  it('admite el rol y el tipo de tarea nuevos', () => {
    const db = openDatabase(':memory:');
    db.exec(`
      INSERT INTO projects (id, name, repo_path, main_branch, max_concurrent_runs, max_task_attempts, run_timeout_ms, status, created_at, updated_at)
      VALUES ('prj_1','p','/tmp/p','main',4,3,900000,'active','2026-01-01','2026-01-01');
    `);

    expect(() =>
      db.prepare(
        `INSERT INTO agents (id, project_id, name, role, engine, instructions, allowed_tools, created_at, updated_at)
         VALUES ('agt_r','prj_1','Refactorer','refactorer','claude_code','x','[]','2026-01-01','2026-01-01')`,
      ).run(),
    ).not.toThrow();

    expect(() =>
      db.prepare(
        `INSERT INTO tasks (id, project_id, kind, title, goal, required_role, priority, status, created_by, created_at, updated_at)
         VALUES ('tsk_r','prj_1','refactor','t','g','refactorer',50,'ready','system','2026-01-01','2026-01-01')`,
      ).run(),
    ).not.toThrow();

    // Y sigue rechazando un rol que no existe.
    expect(() =>
      db.prepare(
        `INSERT INTO agents (id, project_id, name, role, engine, instructions, allowed_tools, created_at, updated_at)
         VALUES ('agt_z','prj_1','Z','inventado','claude_code','x','[]','2026-01-01','2026-01-01')`,
      ).run(),
    ).toThrow(/CHECK constraint/i);

    db.close();
  });

  it('el proyecto arranca en modo normal', () => {
    const db = openDatabase(':memory:');
    db.exec(`
      INSERT INTO projects (id, name, repo_path, main_branch, max_concurrent_runs, max_task_attempts, run_timeout_ms, status, created_at, updated_at)
      VALUES ('prj_1','p','/tmp/p','main',4,3,900000,'active','2026-01-01','2026-01-01');
    `);

    const proyecto = db.prepare('SELECT mode FROM projects WHERE id = ?').get('prj_1') as {
      mode: string;
    };
    expect(proyecto.mode).toBe('normal');
    db.close();
  });
});

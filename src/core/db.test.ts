import { describe, it, expect } from 'vitest';
import { openDatabase, applyMigrations } from './db.js';

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

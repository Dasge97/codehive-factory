import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

/**
 * Abre la base de datos y aplica las migraciones pendientes.
 *
 * El modo WAL permite que las lecturas no bloqueen a la escritura. `foreign_keys` hace
 * que SQLite compruebe las referencias entre tablas, que por omisión están desactivadas.
 * `busy_timeout` evita que una escritura falle de inmediato cuando otra está en curso.
 *
 * Pasar ':memory:' como ruta crea una base de datos temporal, que es lo que usan las
 * pruebas.
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  applyMigrations(db);
  return db;
}

/**
 * Aplica en orden las migraciones que aún no constan como aplicadas. Cada una va en su
 * propia transacción, así que una migración que falle no deja la base a medias.
 */
export function applyMigrations(db: Db): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
  );

  const nuevas: number[] = [];
  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;

    const aplicar = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });

    aplicar();
    nuevas.push(migration.version);
  }

  return nuevas;
}

/**
 * Ejecuta una función dentro de una transacción que toma el bloqueo de escritura desde el
 * principio. Es lo que hace que dos reclamaciones simultáneas de la misma tarea se
 * serialicen en lugar de pisarse (decisión D11).
 */
export function inImmediateTransaction<T>(db: Db, fn: () => T): T {
  const tx = db.transaction(fn);
  return tx.immediate();
}

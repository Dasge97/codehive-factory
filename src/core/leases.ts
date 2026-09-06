import type { Db } from './db.js';
import { inImmediateTransaction } from './db.js';
import { EventBus, insertEvent, publishEvents } from './events.js';
import { requireTask, setStatusInternal } from './tasks.js';
import { now } from '../shared/ids.js';
import type { Run, SystemEvent } from '../shared/types.js';

/**
 * Cuánto vale una asignación antes de caducar, y cada cuánto se renueva.
 *
 * La vigencia tiene que ser bastante más larga que el intervalo de renovación: si fueran
 * parecidos, un retraso normal del sistema daría por perdido a un worker que está vivo.
 */
export const LEASE_TTL_MS = 90_000;
export const LEASE_RENEW_MS = 20_000;

/** Crea o renueva la vigencia de una asignación. */
export function renewLease(db: Db, taskId: string, runId: string, workerId: string, ttlMs = LEASE_TTL_MS): void {
  const momento = now();
  const caduca = new Date(Date.now() + ttlMs).toISOString();

  db.prepare(
    `INSERT INTO leases (task_id, run_id, worker_id, expires_at, renewed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       run_id = excluded.run_id,
       worker_id = excluded.worker_id,
       expires_at = excluded.expires_at,
       renewed_at = excluded.renewed_at`,
  ).run(taskId, runId, workerId, caduca, momento);
}

export function releaseLease(db: Db, taskId: string): void {
  db.prepare('DELETE FROM leases WHERE task_id = ?').run(taskId);
}

export function getLease(db: Db, taskId: string) {
  return db.prepare('SELECT * FROM leases WHERE task_id = ?').get(taskId) as
    | { task_id: string; run_id: string; worker_id: string; expires_at: string; renewed_at: string }
    | undefined;
}

export interface ReclaimResult {
  task_id: string;
  run_id: string;
  worker_id: string;
  had_increment: boolean;
}

/**
 * Recupera las tareas cuyo worker dejó de dar señales.
 *
 * Antes de devolver una tarea a la cola se mira qué dejó hecho el worker perdido: si llegó
 * a publicar un incremento, su trabajo no se tira, y la tarea pasa a revisión en lugar de
 * volver a construirse desde cero.
 */
export function reclaimExpiredLeases(db: Db, bus: EventBus, projectId: string): ReclaimResult[] {
  const caducadas = db
    .prepare(
      `SELECT l.task_id, l.run_id, l.worker_id
       FROM leases l
       JOIN tasks t ON t.id = l.task_id
       WHERE t.project_id = ? AND l.expires_at < ?`,
    )
    .all(projectId, now()) as Array<{ task_id: string; run_id: string; worker_id: string }>;

  const recuperadas: ReclaimResult[] = [];
  const eventos: SystemEvent[] = [];

  for (const caducada of caducadas) {
    const resultado = inImmediateTransaction(db, () => {
      const task = requireTask(db, caducada.task_id);

      // Si la tarea ya cambió de ejecución, otro se ocupó y aquí no hay nada que hacer.
      if (task.active_run_id !== caducada.run_id) {
        releaseLease(db, caducada.task_id);
        return null;
      }

      const incremento = db
        .prepare('SELECT id FROM increments WHERE run_id = ? LIMIT 1')
        .get(caducada.run_id) as { id: string } | undefined;

      db.prepare(
        "UPDATE runs SET status = 'interrupted', error = ?, ended_at = ? WHERE id = ? AND status = 'running'",
      ).run(
        `El worker ${caducada.worker_id} dejó de dar señales y se dio por perdido.`,
        now(),
        caducada.run_id,
      );

      db.prepare('UPDATE tasks SET active_run_id = NULL, updated_at = ? WHERE id = ?').run(
        now(),
        caducada.task_id,
      );

      const eventosTarea =
        task.status === 'in_progress'
          ? setStatusInternal(
              db,
              caducada.task_id,
              incremento ? 'in_review' : 'ready',
              incremento
                ? 'el worker se perdió, pero su incremento ya estaba publicado'
                : 'el worker se dio por perdido',
            )
          : [];

      releaseLease(db, caducada.task_id);

      eventos.push(
        insertEvent(db, {
          project_id: task.project_id,
          type: 'run.finished',
          task_id: caducada.task_id,
          run_id: caducada.run_id,
          payload: {
            status: 'interrupted',
            reason: 'worker perdido',
            worker_id: caducada.worker_id,
            kept_increment: Boolean(incremento),
          },
        }),
        ...eventosTarea,
      );

      return { ...caducada, had_increment: Boolean(incremento) };
    });

    if (resultado) recuperadas.push(resultado);
  }

  publishEvents(bus, eventos);
  return recuperadas;
}

/**
 * Comprueba si una ejecución sigue siendo la vigente de su tarea.
 *
 * Un worker dado por perdido puede volver en sí y devolver un resultado tarde. Ese
 * resultado no puede sobrescribir el trabajo de quien tomó la tarea después (documento
 * 07, apartado 7.3 del plan de la fase 2).
 */
export function isRunCurrent(db: Db, runId: string): boolean {
  const run = db.prepare('SELECT task_id FROM runs WHERE id = ?').get(runId) as { task_id: string } | undefined;
  if (!run) return false;

  const task = db.prepare('SELECT active_run_id FROM tasks WHERE id = ?').get(run.task_id) as
    | { active_run_id: string | null }
    | undefined;

  return task?.active_run_id === runId;
}

/**
 * Registra un resultado que llegó cuando su ejecución ya había sido sustituida. Se guarda
 * el motivo para poder mirarlo después, pero no cambia nada del estado vigente.
 */
export function recordStaleResult(db: Db, bus: EventBus, runId: string, resumen: string | null): void {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Run | undefined;
  if (!run) return;

  // La ejecución puede estar ya marcada como interrumpida por el barrido de vigencias.
  // El motivo del descarte se añade al que hubiera, en lugar de sustituirlo.
  const nota = 'El resultado llegó cuando la tarea ya había pasado a otra ejecución, así que se descartó.';
  const motivo = run.error ? `${run.error} ${nota}` : nota;

  db.prepare(
    `UPDATE runs SET status = 'interrupted', error = ?, summary = ?, ended_at = COALESCE(ended_at, ?)
     WHERE id = ?`,
  ).run(motivo, resumen, now(), runId);

  const task = requireTask(db, run.task_id);
  publishEvents(bus, [
    insertEvent(db, {
      project_id: task.project_id,
      type: 'run.finished',
      task_id: run.task_id,
      run_id: runId,
      payload: { status: 'interrupted', reason: 'resultado tardío descartado', summary: resumen },
    }),
  ]);
}

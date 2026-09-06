import type { Db } from './db.js';
import { inImmediateTransaction } from './db.js';
import { EventBus, insertEvent, publishEvents } from './events.js';
import { RuleError, requireTask, taskPathPatterns } from './tasks.js';
import { newId, now } from '../shared/ids.js';
import type { AgentRole, EngineName, Run, SystemEvent, Task } from '../shared/types.js';

/**
 * Puntos de prioridad que gana una tarea por cada hora esperando en la cola.
 *
 * Menor número significa antes. Restar un punto por hora hace que una tarea antigua acabe
 * adelantando a correcciones menores recién creadas, que es lo que evita que el trabajo
 * viejo se quede sin atender indefinidamente (documento 07, apartado 7.5).
 */
export const PUNTOS_POR_HORA_ESPERANDO = 1;

/**
 * Quita los comodines finales de un patrón para quedarse con la parte fija de la ruta.
 * `src/core/**` se convierte en `src/core/`.
 */
function raizDelPatron(patron: string): string {
  const corte = patron.search(/[*?[]/);
  const fijo = corte === -1 ? patron : patron.slice(0, corte);
  return fijo.replace(/\\/g, '/');
}

/**
 * Dos patrones chocan cuando uno cubre lo que el otro puede tocar. Se comparan sus partes
 * fijas: si una es prefijo de la otra, las dos tareas podrían escribir el mismo fichero.
 *
 * Es una comprobación conservadora a propósito. Puede rechazar una pareja que en realidad
 * no coincidiría, y eso solo retrasa una tarea. Lo contrario, dejar pasar dos tareas que
 * sí chocan, produce un conflicto que nadie ha pedido.
 */
export function patronesColisionan(a: string, b: string): boolean {
  const ra = raizDelPatron(a);
  const rb = raizDelPatron(b);
  return ra.startsWith(rb) || rb.startsWith(ra);
}

export interface QueueEntry {
  task: Task;
  priority_efectiva: number;
  espera_horas: number;
}

/**
 * Tareas que un rol podría reclamar ahora mismo, de la más urgente a la menos.
 *
 * Una tarea entra en la lista si está lista, su rol coincide, todas sus dependencias
 * están cerradas y ninguno de los ficheros que reserva está ya reservado por otra tarea
 * activa.
 */
export function queueForRole(db: Db, projectId: string, role: AgentRole): QueueEntry[] {
  const candidatas = db
    .prepare(
      `SELECT t.*,
              (julianday('now') - julianday(t.updated_at)) * 24 AS espera_horas
       FROM tasks t
       WHERE t.project_id = ?
         AND t.status = 'ready'
         AND t.required_role = ?
         AND NOT EXISTS (
           SELECT 1 FROM task_dependencies d
           JOIN tasks dep ON dep.id = d.depends_on_id
           WHERE d.task_id = t.id AND dep.status NOT IN ('done','cancelled')
         )
       ORDER BY t.priority ASC, t.created_at ASC`,
    )
    .all(projectId, role) as Array<Task & { espera_horas: number }>;

  const bloqueosActivos = db
    .prepare(
      `SELECT task_id, path_pattern
       FROM resource_locks
       WHERE project_id = ? AND released_at IS NULL`,
    )
    .all(projectId) as Array<{ task_id: string; path_pattern: string }>;

  const entradas: QueueEntry[] = [];
  for (const fila of candidatas) {
    const { espera_horas, ...task } = fila;
    const propios = taskPathPatterns(db, task.id);

    const chocaConOtra = bloqueosActivos.some(
      (bloqueo) =>
        bloqueo.task_id !== task.id &&
        propios.some((propio) => patronesColisionan(propio, bloqueo.path_pattern)),
    );
    if (chocaConOtra) continue;

    const horas = Math.max(0, espera_horas ?? 0);
    entradas.push({
      task: task as Task,
      espera_horas: horas,
      priority_efectiva: task.priority - Math.floor(horas) * PUNTOS_POR_HORA_ESPERANDO,
    });
  }

  entradas.sort(
    (a, b) =>
      a.priority_efectiva - b.priority_efectiva ||
      a.task.created_at.localeCompare(b.task.created_at),
  );
  return entradas;
}

/** Motivo por el que una tarea lista no se puede reclamar todavía. */
export function razonDeEspera(db: Db, taskId: string): string | null {
  const task = requireTask(db, taskId);

  const abiertas = db
    .prepare(
      `SELECT dep.id, dep.title
       FROM task_dependencies d
       JOIN tasks dep ON dep.id = d.depends_on_id
       WHERE d.task_id = ? AND dep.status NOT IN ('done','cancelled')`,
    )
    .all(taskId) as Array<{ id: string; title: string }>;

  if (abiertas.length > 0) {
    return `Espera a que terminen: ${abiertas.map((d) => d.title).join(', ')}.`;
  }

  const propios = taskPathPatterns(db, taskId);
  const bloqueos = db
    .prepare(
      `SELECT l.path_pattern, t.title
       FROM resource_locks l
       JOIN tasks t ON t.id = l.task_id
       WHERE l.project_id = ? AND l.released_at IS NULL AND l.task_id <> ?`,
    )
    .all(task.project_id, taskId) as Array<{ path_pattern: string; title: string }>;

  for (const bloqueo of bloqueos) {
    if (propios.some((p) => patronesColisionan(p, bloqueo.path_pattern))) {
      return `Los ficheros ${bloqueo.path_pattern} los tiene reservados la tarea "${bloqueo.title}".`;
    }
  }
  return null;
}

export interface ClaimInput {
  task_id: string;
  agent_id: string;
  worker_id: string;
  engine: EngineName;
  input_commit?: string | null;
}

export interface ClaimResult {
  claimed: boolean;
  run?: Run;
  task?: Task;
  reason?: string;
}

/**
 * Intenta convertirse en responsable de una tarea.
 *
 * Todo ocurre en una transacción que toma el bloqueo de escritura desde el principio. El
 * UPDATE solo cambia la tarea si sigue estando lista y sin ejecución activa, así que de
 * dos workers que lo intenten a la vez, el segundo verá cero filas afectadas y se irá con
 * las manos vacías en lugar de duplicar el trabajo (decisión D11).
 *
 * En la misma transacción se adquieren los bloqueos de los ficheros que la tarea reserva
 * y se crea la ejecución. Si algo falla, no queda ni tarea reclamada ni bloqueo colgando.
 */
export function claimTask(db: Db, bus: EventBus, input: ClaimInput): ClaimResult {
  const eventos: SystemEvent[] = [];

  const resultado = inImmediateTransaction<ClaimResult>(db, () => {
    const task = requireTask(db, input.task_id);

    const bloqueado = razonDeEspera(db, input.task_id);
    if (bloqueado) return { claimed: false, reason: bloqueado };

    const runId = newId('run');
    const momento = now();

    const cambio = db
      .prepare(
        `UPDATE tasks
         SET status = 'in_progress',
             assigned_agent_id = ?,
             active_run_id = ?,
             attempts = attempts + 1,
             updated_at = ?
         WHERE id = ?
           AND status = 'ready'
           AND active_run_id IS NULL`,
      )
      .run(input.agent_id, runId, momento, input.task_id);

    if (cambio.changes !== 1) {
      return { claimed: false, reason: 'Otro worker reclamó la tarea antes.' };
    }

    // Los bloqueos se activan ahora, no al crear la tarea: declarar ficheros no debe
    // impedir que otras tareas avancen mientras esta espera en la cola.
    db.prepare(
      `UPDATE resource_locks
       SET acquired_at = ?, released_at = NULL
       WHERE task_id = ?`,
    ).run(momento, input.task_id);

    db.prepare(
      `INSERT INTO runs (id, task_id, agent_id, worker_id, engine, status, input_commit, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
    ).run(
      runId,
      input.task_id,
      input.agent_id,
      input.worker_id,
      input.engine,
      input.input_commit ?? task.head_commit ?? task.base_commit ?? null,
      momento,
    );

    eventos.push(
      insertEvent(db, {
        project_id: task.project_id,
        type: 'task.status_changed',
        task_id: task.id,
        run_id: runId,
        agent_id: input.agent_id,
        payload: { from: 'ready', to: 'in_progress', reason: 'reclamada por un worker' },
      }),
      insertEvent(db, {
        project_id: task.project_id,
        type: 'run.started',
        task_id: task.id,
        run_id: runId,
        agent_id: input.agent_id,
        payload: { worker_id: input.worker_id, engine: input.engine, attempt: task.attempts + 1 },
      }),
    );

    return {
      claimed: true,
      run: db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Run,
      task: requireTask(db, input.task_id),
    };
  });

  publishEvents(bus, eventos);
  return resultado;
}

/**
 * Reclama la primera tarea disponible para un rol. Si otro worker se adelanta, prueba con
 * la siguiente en lugar de rendirse.
 */
export function claimNext(
  db: Db,
  bus: EventBus,
  projectId: string,
  role: AgentRole,
  agente: { agent_id: string; worker_id: string; engine: EngineName },
): ClaimResult {
  for (const entrada of queueForRole(db, projectId, role)) {
    const resultado = claimTask(db, bus, { task_id: entrada.task.id, ...agente });
    if (resultado.claimed) return resultado;
  }
  return { claimed: false, reason: 'No hay ninguna tarea disponible para este rol.' };
}

/** Comprueba las reglas de integridad del apartado 4.5 del documento del modelo de datos. */
export function checkIntegrity(db: Db, projectId: string): string[] {
  const problemas: string[] = [];

  const enCursoSinEjecucion = db
    .prepare(
      `SELECT t.id FROM tasks t
       LEFT JOIN runs r ON r.id = t.active_run_id
       WHERE t.project_id = ? AND t.status = 'in_progress'
         AND (r.id IS NULL OR r.status <> 'running')`,
    )
    .all(projectId) as Array<{ id: string }>;
  for (const t of enCursoSinEjecucion) {
    problemas.push(`La tarea ${t.id} está en curso pero no tiene una ejecución activa.`);
  }

  const hechasConBloqueantes = db
    .prepare(
      `SELECT DISTINCT t.id FROM tasks t
       JOIN findings f ON f.source_task_id = t.id
       WHERE t.project_id = ? AND t.status = 'done'
         AND f.status = 'open' AND f.severity = 'blocker'`,
    )
    .all(projectId) as Array<{ id: string }>;
  for (const t of hechasConBloqueantes) {
    problemas.push(`La tarea ${t.id} está terminada pero tiene hallazgos bloqueantes abiertos.`);
  }

  const bloqueosHuerfanos = db
    .prepare(
      `SELECT l.id, l.task_id FROM resource_locks l
       JOIN tasks t ON t.id = l.task_id
       WHERE l.project_id = ? AND l.released_at IS NULL
         AND t.status IN ('done','cancelled')`,
    )
    .all(projectId) as Array<{ id: string; task_id: string }>;
  for (const l of bloqueosHuerfanos) {
    problemas.push(`El bloqueo ${l.id} sigue activo pero su tarea ${l.task_id} ya está cerrada.`);
  }

  const correccionesMalVinculadas = db
    .prepare(
      `SELECT f.id FROM findings f
       JOIN tasks t ON t.id = f.fix_task_id
       WHERE f.project_id = ? AND t.kind <> 'fix'`,
    )
    .all(projectId) as Array<{ id: string }>;
  for (const f of correccionesMalVinculadas) {
    problemas.push(`El hallazgo ${f.id} apunta a una tarea que no es de corrección.`);
  }

  return problemas;
}

/** Marca una ejecución como terminada y devuelve la tarea al estado que corresponda. */
export function abandonRun(db: Db, bus: EventBus, runId: string, motivo: string): void {
  const eventos = inImmediateTransaction<SystemEvent[]>(db, () => {
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Run | undefined;
    if (!run) throw new RuleError(`La ejecución ${runId} no existe.`);

    db.prepare("UPDATE runs SET status = 'interrupted', error = ?, ended_at = ? WHERE id = ?").run(
      motivo,
      now(),
      runId,
    );
    db.prepare(
      "UPDATE tasks SET status = 'ready', active_run_id = NULL, updated_at = ? WHERE id = ? AND active_run_id = ?",
    ).run(now(), run.task_id, runId);

    const task = requireTask(db, run.task_id);
    return [
      insertEvent(db, {
        project_id: task.project_id,
        type: 'run.finished',
        task_id: task.id,
        run_id: runId,
        payload: { status: 'interrupted', reason: motivo },
      }),
    ];
  });

  publishEvents(bus, eventos);
}

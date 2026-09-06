import type { Db } from './db.js';
import { inImmediateTransaction } from './db.js';
import { EventBus, insertEvent, publishEvents } from './events.js';
import { newId, now } from '../shared/ids.js';
import {
  TERMINAL_TASK_STATUSES,
  type AgentRole,
  type SystemEvent,
  type Task,
  type TaskKind,
  type TaskStatus,
} from '../shared/types.js';

/** Error de una operación que el sistema rechaza por sus propias reglas, no por un fallo técnico. */
export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleError';
  }
}

// ---------------------------------------------------------------------------
// Transiciones de estado
// ---------------------------------------------------------------------------

/**
 * Estados a los que puede pasar una tarea desde cada estado.
 *
 * Cancelar es posible desde cualquier estado no terminal, porque es una decisión del
 * creador que no debe depender de en qué punto esté el trabajo.
 *
 * De `done` solo se sale a `ready`, y solo por un motivo: la integración falló. Una tarea
 * aprobada sobre su rama aislada puede dar conflicto al fusionar, o romper las
 * verificaciones una vez fusionada, y entonces vuelve a necesitar trabajo (documento 07,
 * apartado 7.7).
 */
const TRANSICIONES: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['ready', 'blocked', 'cancelled'],
  ready: ['pending', 'in_progress', 'blocked', 'cancelled'],
  in_progress: ['ready', 'in_review', 'blocked', 'done', 'cancelled'],
  in_review: ['ready', 'blocked', 'done', 'cancelled'],
  blocked: ['pending', 'ready', 'cancelled'],
  done: ['ready'],
  cancelled: [],
};

export function puedeTransicionar(desde: TaskStatus, hacia: TaskStatus): boolean {
  return TRANSICIONES[desde].includes(hacia);
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export function getTask(db: Db, taskId: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
}

export function requireTask(db: Db, taskId: string): Task {
  const task = getTask(db, taskId);
  if (!task) throw new RuleError(`La tarea ${taskId} no existe.`);
  return task;
}

export function listTasks(
  db: Db,
  projectId: string,
  filtro: { status?: TaskStatus; role?: AgentRole } = {},
): Task[] {
  const condiciones = ['project_id = ?'];
  const valores: unknown[] = [projectId];
  if (filtro.status) {
    condiciones.push('status = ?');
    valores.push(filtro.status);
  }
  if (filtro.role) {
    condiciones.push('required_role = ?');
    valores.push(filtro.role);
  }
  return db
    .prepare(`SELECT * FROM tasks WHERE ${condiciones.join(' AND ')} ORDER BY priority ASC, created_at ASC`)
    .all(...valores) as Task[];
}

/** Identificadores de las dependencias de una tarea que todavía no están cerradas. */
export function pendingDependencies(db: Db, taskId: string): string[] {
  return db
    .prepare(
      `SELECT d.depends_on_id AS id
       FROM task_dependencies d
       JOIN tasks dep ON dep.id = d.depends_on_id
       WHERE d.task_id = ? AND dep.status NOT IN ('done','cancelled')`,
    )
    .all(taskId)
    .map((r) => (r as { id: string }).id);
}

// ---------------------------------------------------------------------------
// Creación
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  project_id: string;
  kind: TaskKind;
  title: string;
  goal: string;
  required_role: AgentRole;
  created_by: string;
  scope?: string | null;
  acceptance?: string | null;
  priority?: number;
  parent_task_id?: string | null;
  depends_on?: string[];
  path_patterns?: string[];
  branch?: string | null;
  base_commit?: string | null;
  decision_revision?: number;
}

/**
 * Crea una tarea con sus dependencias y los ficheros que se reserva.
 *
 * La tarea nace en estado `pending` y pasa a `ready` en el mismo momento si no tiene
 * dependencias abiertas. Los patrones de ruta se guardan como bloqueos ya liberados: el
 * bloqueo real se adquiere al reclamar la tarea, no al crearla, para que declarar
 * ficheros no impida que otra tarea trabaje mientras esta espera en la cola.
 */
export function createTask(db: Db, bus: EventBus, input: CreateTaskInput): Task {
  const eventos: SystemEvent[] = [];

  const task = inImmediateTransaction(db, () => {
    const id = newId('task');
    const creado = now();

    const proyecto = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.project_id);
    if (!proyecto) throw new RuleError(`El proyecto ${input.project_id} no existe.`);

    db.prepare(
      `INSERT INTO tasks (
         id, project_id, parent_task_id, kind, title, goal, scope, acceptance,
         required_role, priority, status, branch, base_commit, decision_revision,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.project_id,
      input.parent_task_id ?? null,
      input.kind,
      input.title,
      input.goal,
      input.scope ?? null,
      input.acceptance ?? null,
      input.required_role,
      input.priority ?? 50,
      input.branch ?? null,
      input.base_commit ?? null,
      input.decision_revision ?? 1,
      input.created_by,
      creado,
      creado,
    );

    for (const dependencia of input.depends_on ?? []) {
      addDependencyInternal(db, id, dependencia);
    }

    for (const patron of input.path_patterns ?? []) {
      db.prepare(
        `INSERT INTO resource_locks (id, project_id, task_id, path_pattern, acquired_at, released_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(newId('lock'), input.project_id, id, patron, creado, creado);
    }

    const creada = requireTask(db, id);
    eventos.push(insertEvent(db, {
      project_id: input.project_id,
      type: 'task.created',
      task_id: id,
      payload: { task: creada },
    }));

    // Si no tiene dependencias abiertas, puede reclamarse ya.
    if (pendingDependencies(db, id).length === 0) {
      eventos.push(...setStatusInternal(db, id, 'ready', 'sin dependencias abiertas'));
    }

    return requireTask(db, id);
  });

  publishEvents(bus, eventos);
  return task;
}

/**
 * Registra que una tarea depende de otra. Rechaza el ciclo antes de guardarlo: una
 * dependencia circular dejaría las dos tareas esperándose para siempre.
 */
function addDependencyInternal(db: Db, taskId: string, dependsOnId: string): void {
  if (taskId === dependsOnId) throw new RuleError('Una tarea no puede depender de sí misma.');

  const existe = db.prepare('SELECT id FROM tasks WHERE id = ?').get(dependsOnId);
  if (!existe) throw new RuleError(`La dependencia ${dependsOnId} no existe.`);

  if (alcanzable(db, dependsOnId, taskId)) {
    throw new RuleError(
      `Añadir la dependencia ${taskId} -> ${dependsOnId} crearía un ciclo de dependencias.`,
    );
  }

  db.prepare(
    'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)',
  ).run(taskId, dependsOnId);
}

export function addDependency(db: Db, taskId: string, dependsOnId: string): void {
  inImmediateTransaction(db, () => addDependencyInternal(db, taskId, dependsOnId));
}

/** Comprueba si desde una tarea se llega a otra siguiendo la cadena de dependencias. */
function alcanzable(db: Db, desde: string, hasta: string): boolean {
  const porVisitar = [desde];
  const vistos = new Set<string>();

  while (porVisitar.length > 0) {
    const actual = porVisitar.pop()!;
    if (actual === hasta) return true;
    if (vistos.has(actual)) continue;
    vistos.add(actual);

    const siguientes = db
      .prepare('SELECT depends_on_id AS id FROM task_dependencies WHERE task_id = ?')
      .all(actual)
      .map((r) => (r as { id: string }).id);
    porVisitar.push(...siguientes);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cambio de estado
// ---------------------------------------------------------------------------

/**
 * Cambia el estado de una tarea validando que la transición esté permitida. Devuelve los
 * eventos generados sin publicarlos, para que quien llama pueda hacerlo tras cerrar la
 * transacción.
 */
export function setStatusInternal(
  db: Db,
  taskId: string,
  nuevo: TaskStatus,
  motivo: string | null = null,
): SystemEvent[] {
  const task = requireTask(db, taskId);
  if (task.status === nuevo) return [];

  if (!puedeTransicionar(task.status, nuevo)) {
    throw new RuleError(
      `La tarea ${taskId} no puede pasar de ${task.status} a ${nuevo}.`,
    );
  }

  const momento = now();
  const cerrada = TERMINAL_TASK_STATUSES.includes(nuevo);

  db.prepare(
    `UPDATE tasks
     SET status = ?,
         blocked_reason = ?,
         closed_at = CASE WHEN ? THEN ? ELSE NULL END,
         updated_at = ?
     WHERE id = ?`,
  ).run(nuevo, nuevo === 'blocked' ? motivo : null, cerrada ? 1 : 0, momento, momento, taskId);

  // Al cerrar una tarea se sueltan sus reservas de ficheros para que otras puedan avanzar.
  if (cerrada) {
    releaseLocksInternal(db, taskId);
  }

  const eventos: SystemEvent[] = [
    insertEvent(db, {
      project_id: task.project_id,
      type: 'task.status_changed',
      task_id: taskId,
      payload: { from: task.status, to: nuevo, reason: motivo },
    }),
  ];

  if (nuevo === 'blocked') {
    eventos.push(
      insertEvent(db, {
        project_id: task.project_id,
        type: 'task.blocked',
        task_id: taskId,
        payload: { reason: motivo },
      }),
    );
  }

  // Cerrar una tarea puede desbloquear a las que dependían de ella.
  if (cerrada) {
    eventos.push(...refreshReadinessInternal(db, task.project_id));
  }

  return eventos;
}

export function setStatus(
  db: Db,
  bus: EventBus,
  taskId: string,
  nuevo: TaskStatus,
  motivo: string | null = null,
): Task {
  const eventos = inImmediateTransaction(db, () => setStatusInternal(db, taskId, nuevo, motivo));
  publishEvents(bus, eventos);
  return requireTask(db, taskId);
}

/**
 * Pasa a `ready` las tareas pendientes que ya tienen todas sus dependencias cerradas, y
 * devuelve a `pending` las que estaban listas y han vuelto a depender de algo abierto.
 */
export function refreshReadinessInternal(db: Db, projectId: string): SystemEvent[] {
  const eventos: SystemEvent[] = [];

  const pendientes = db
    .prepare("SELECT id FROM tasks WHERE project_id = ? AND status = 'pending'")
    .all(projectId)
    .map((r) => (r as { id: string }).id);

  for (const id of pendientes) {
    if (pendingDependencies(db, id).length === 0) {
      eventos.push(...setStatusInternal(db, id, 'ready', 'dependencias cerradas'));
    }
  }

  const listas = db
    .prepare("SELECT id FROM tasks WHERE project_id = ? AND status = 'ready'")
    .all(projectId)
    .map((r) => (r as { id: string }).id);

  for (const id of listas) {
    if (pendingDependencies(db, id).length > 0) {
      eventos.push(...setStatusInternal(db, id, 'pending', 'apareció una dependencia abierta'));
    }
  }

  return eventos;
}

export function refreshReadiness(db: Db, bus: EventBus, projectId: string): void {
  const eventos = inImmediateTransaction(db, () => refreshReadinessInternal(db, projectId));
  publishEvents(bus, eventos);
}

// ---------------------------------------------------------------------------
// Bloqueos de recursos
// ---------------------------------------------------------------------------

/** Marca como liberados todos los bloqueos activos de una tarea. */
export function releaseLocksInternal(db: Db, taskId: string): void {
  db.prepare(
    'UPDATE resource_locks SET released_at = ? WHERE task_id = ? AND released_at IS NULL',
  ).run(now(), taskId);
}

/** Patrones de ruta que una tarea tiene declarados, estén activos o no. */
export function taskPathPatterns(db: Db, taskId: string): string[] {
  return db
    .prepare('SELECT DISTINCT path_pattern FROM resource_locks WHERE task_id = ?')
    .all(taskId)
    .map((r) => (r as { path_pattern: string }).path_pattern);
}

// ---------------------------------------------------------------------------
// Prioridad y avisos
// ---------------------------------------------------------------------------

export function setPriority(db: Db, bus: EventBus, taskId: string, priority: number): Task {
  const task = requireTask(db, taskId);
  db.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?').run(priority, now(), taskId);
  publishEvents(bus, [
    insertEvent(db, {
      project_id: task.project_id,
      type: 'task.status_changed',
      task_id: taskId,
      payload: { from: task.status, to: task.status, reason: `prioridad cambiada a ${priority}` },
    }),
  ]);
  return requireTask(db, taskId);
}

/**
 * Deja un aviso para una tarea. El agente lo recibe en su siguiente ejecución, no en la
 * que tenga en curso: el punto seguro para interrumpir es el final de una ejecución
 * (decisión D12).
 */
export function addNotice(db: Db, taskId: string, from: string, body: string): void {
  db.prepare(
    'INSERT INTO notices (id, task_id, from_actor, body, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(newId('notice'), taskId, from, body, now());
}

/** Avisos que aún no se han entregado a una tarea. */
export function pendingNotices(db: Db, taskId: string): Array<{ from: string; body: string }> {
  return db
    .prepare('SELECT from_actor AS "from", body FROM notices WHERE task_id = ? AND delivered_at IS NULL ORDER BY created_at')
    .all(taskId) as Array<{ from: string; body: string }>;
}

export function markNoticesDelivered(db: Db, taskId: string): void {
  db.prepare('UPDATE notices SET delivered_at = ? WHERE task_id = ? AND delivered_at IS NULL').run(
    now(),
    taskId,
  );
}

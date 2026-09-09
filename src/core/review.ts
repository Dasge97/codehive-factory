import type { Db } from './db.js';
import { inImmediateTransaction } from './db.js';
import { EventBus, insertEvent, publishEvents } from './events.js';
import { requireProject } from './projects.js';
import { RuleError, addNotice, createTask, requireTask, setStatusInternal } from './tasks.js';
import { newId, now } from '../shared/ids.js';
import type {
  AgentResult,
  Finding,
  FindingInput,
  Increment,
  Project,
  SystemEvent,
  Task,
} from '../shared/types.js';

/** Prioridad con la que vuelve a la cola una tarea con hallazgos, según lo grave que sea el peor. */
const PRIORIDAD_POR_GRAVEDAD = { blocker: 5, major: 20, minor: 60 } as const;

/** Gravedades que obligan a corregir antes de dar el trabajo por bueno. */
const OBLIGAN_A_CORREGIR = new Set(['blocker', 'major']);

/** Tipos de tarea cuyo trabajo aprobado pasa por el refactorer en modo estricto. */
const PASAN_POR_REFACTORER = new Set(['build', 'fix']);

/**
 * Decide si el incremento de una tarea tiene que pasar por el reviewer.
 *
 * Son dos reglas superpuestas. El orquestador marca cada tarea al crearla, y por encima
 * de su decisión hay un suelo que el sistema aplica siempre: si la verificación del
 * proyecto no pasó, si el proyecto no tiene con qué verificarse, o si el agente terminó
 * a medias, se revisa aunque el orquestador dijera que no hacía falta.
 *
 * El suelo es lo que hace que equivocarse marcando una tarea no pueda dejar pasar código
 * roto.
 */
export function necesitaRevision(
  project: Project,
  task: Task,
  result: AgentResult | null,
): { revisar: boolean; motivo: string } {
  if (project.mode === 'strict') {
    return { revisar: true, motivo: 'el proyecto está en modo estricto' };
  }

  if (task.needs_review !== 0) {
    return { revisar: true, motivo: 'la tarea está marcada para revisar' };
  }

  if (!result) {
    return { revisar: true, motivo: 'la ejecución no devolvió un resultado que comprobar' };
  }

  if (!project.verify_command) {
    return { revisar: true, motivo: 'el proyecto no tiene comando de verificación' };
  }

  const verificacion = result.verification;
  if (!verificacion?.ran) {
    return { revisar: true, motivo: 'la verificación del proyecto no se ejecutó' };
  }
  if (verificacion.passed !== true) {
    return { revisar: true, motivo: 'la verificación del proyecto no pasó' };
  }

  if (result.outcome !== 'completed') {
    return { revisar: true, motivo: `el agente terminó con ${result.outcome}` };
  }

  if ((result.needs?.length ?? 0) > 0) {
    return { revisar: true, motivo: 'el agente necesitó algo fuera de su alcance' };
  }

  return { revisar: false, motivo: 'cambio verificado y sin nada pendiente' };
}

export interface PublishIncrementInput {
  task_id: string;
  run_id: string;
  commit_sha: string;
  branch: string;
  message: string;
  files: string[];
  /** Lo que devolvió el agente, para poder aplicar el suelo de revisión. */
  result?: AgentResult | null;
}

export interface PublishIncrementResult {
  increment: Increment;
  review_task: Task | null;
}

/**
 * Registra el incremento que acaba de publicar un agente y abre su revisión.
 *
 * La tarea de construcción pasa a estado en revisión, lo que la saca de la cola sin
 * cerrarla. El worker que la traía queda libre para coger otra tarea mientras el reviewer
 * trabaja: es lo que hace que la construcción y la revisión avancen a la vez (requisito
 * A02).
 */
export function publishIncrement(
  db: Db,
  bus: EventBus,
  input: PublishIncrementInput,
): PublishIncrementResult {
  const eventos: SystemEvent[] = [];

  const resultado = inImmediateTransaction<PublishIncrementResult>(db, () => {
    const task = requireTask(db, input.task_id);
    const id = newId('increment');

    db.prepare(
      `INSERT INTO increments (id, task_id, run_id, commit_sha, branch, message, files_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.task_id,
      input.run_id,
      input.commit_sha,
      input.branch,
      input.message,
      JSON.stringify(input.files),
      now(),
    );

    db.prepare('UPDATE tasks SET head_commit = ?, updated_at = ? WHERE id = ?').run(
      input.commit_sha,
      now(),
      input.task_id,
    );

    const increment = db.prepare('SELECT * FROM increments WHERE id = ?').get(id) as Increment;

    eventos.push(
      insertEvent(db, {
        project_id: task.project_id,
        type: 'increment.published',
        task_id: task.id,
        run_id: input.run_id,
        payload: {
          increment_id: id,
          commit: input.commit_sha,
          branch: input.branch,
          message: input.message,
          files: input.files,
        },
      }),
    );

    return { increment, review_task: null };
  });

  publishEvents(bus, eventos);

  // La tarea de revisión se crea fuera de la transacción anterior porque `createTask`
  // abre la suya propia.
  const task = requireTask(db, input.task_id);
  if (task.kind === 'review') return resultado;

  const decision = necesitaRevision(requireProject(db, task.project_id), task, input.result ?? null);
  if (!decision.revisar) {
    publishEvents(bus, [
      insertEvent(db, {
        project_id: task.project_id,
        type: 'review.skipped',
        task_id: task.id,
        run_id: input.run_id,
        payload: { increment_id: resultado.increment.id, reason: decision.motivo },
      }),
    ]);
    return resultado;
  }

  const reviewTask = createReviewTask(db, bus, task, resultado.increment);
  return { increment: resultado.increment, review_task: reviewTask };
}

/** Crea la tarea con la que el reviewer examinará un incremento concreto. */
export function createReviewTask(db: Db, bus: EventBus, task: Task, increment: Increment): Task {
  const revision = createTask(db, bus, {
    project_id: task.project_id,
    parent_task_id: task.id,
    kind: 'review',
    title: `Revisar: ${task.title}`,
    goal: `Revisar el commit ${increment.commit_sha.slice(0, 8)} de la rama ${increment.branch} contra los criterios de aceptación de la tarea original.`,
    scope: `Solo el incremento ${increment.id}. No modifiques ficheros del proyecto.`,
    acceptance: task.acceptance,
    required_role: 'reviewer',
    priority: Math.max(1, task.priority - 5),
    created_by: 'system',
    branch: increment.branch,
    base_commit: increment.commit_sha,
  });

  db.prepare('UPDATE tasks SET head_commit = ? WHERE id = ?').run(increment.commit_sha, revision.id);
  return requireTask(db, revision.id);
}

export interface OpenFindingsInput {
  review_task_id: string;
  increment_id: string;
  findings: FindingInput[];
}

export interface OpenFindingsResult {
  findings: Finding[];
  /** Verdadero si la tarea revisada vuelve a la cola para corregir lo encontrado. */
  reopened: boolean;
  blocking: boolean;
  /** La tarea de limpieza que abre el modo estricto cuando la revisión aprueba. */
  refactor_task: Task | null;
}

/**
 * Registra el veredicto de una revisión y decide qué pasa con la tarea revisada.
 *
 * Con hallazgos que obligan a corregir, la propia tarea revisada vuelve a la cola con
 * ellos delante, y su siguiente intento trabaja sobre la misma rama. No se crea ninguna
 * tarea aparte para corregir: una unidad de trabajo integrable es una tarea, una rama y un
 * worktree, y quien mejor sabe arreglar un incremento es quien lo escribió (decisión D44).
 *
 * Con hallazgos leves o sin ninguno, el incremento queda aprobado. Los leves se registran
 * para que el creador los vea, sin abrir trabajo: si cada detalle menor volviera a poner
 * la tarea en la cola, el proyecto no avanzaría nunca.
 */
export function openFindings(db: Db, bus: EventBus, input: OpenFindingsInput): OpenFindingsResult {
  const reviewTask = requireTask(db, input.review_task_id);
  const sourceTaskId = reviewTask.parent_task_id;
  if (!sourceTaskId) {
    throw new RuleError(`La tarea de revisión ${reviewTask.id} no apunta a la tarea revisada.`);
  }
  const sourceTask = requireTask(db, sourceTaskId);
  const project = requireProject(db, sourceTask.project_id);

  // Un veredicto nuevo sustituye al anterior. Lo que el reviewer no vuelve a abrir sobre
  // este incremento se da por resuelto: sus instrucciones le piden repetir lo que siga mal.
  resolveOpenFindings(db, bus, sourceTaskId, input.increment_id);

  const creados: Finding[] = [];
  const eventos: SystemEvent[] = [];

  for (const entrada of input.findings) {
    const id = newId('finding');
    inImmediateTransaction(db, () => {
      db.prepare(
        `INSERT INTO findings (
           id, project_id, increment_id, source_task_id, severity, title, detail,
           resolution, file_path, line, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      ).run(
        id,
        reviewTask.project_id,
        input.increment_id,
        sourceTaskId,
        entrada.severity,
        entrada.title,
        entrada.detail,
        entrada.resolution,
        entrada.file_path ?? null,
        entrada.line ?? null,
        now(),
      );
    });

    const finding = db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as Finding;
    creados.push(finding);

    eventos.push(
      insertEvent(db, {
        project_id: reviewTask.project_id,
        type: 'finding.opened',
        task_id: sourceTaskId,
        payload: {
          finding_id: id,
          severity: entrada.severity,
          title: entrada.title,
          review_task_id: reviewTask.id,
        },
      }),
    );
  }

  const corregir = creados.filter((f) => OBLIGAN_A_CORREGIR.has(f.severity));
  const blocking = creados.some((f) => f.severity === 'blocker');

  const eventosEstado = inImmediateTransaction(db, () => {
    db.prepare('UPDATE increments SET review_status = ? WHERE id = ?').run(
      corregir.length === 0 ? 'approved' : 'rejected',
      input.increment_id,
    );

    if (corregir.length === 0) return aprobar(db, sourceTaskId);
    return devolverACorregir(db, project, sourceTaskId, corregir);
  });

  publishEvents(bus, [...eventos, ...eventosEstado]);

  // En modo estricto, el trabajo aprobado sigue camino hacia el refactorer. La cadena no
  // se puede encadenar sola: un refactor aprobado no abre otro refactor.
  const refactor = corregir.length === 0 ? crearRefactorSiProcede(db, bus, sourceTask, input.increment_id) : null;

  // Si no hay limpieza pendiente, el trabajo aprobado queda hecho. Si la hay, la tarea
  // espera en revisión hasta que el refactorer termine: integrar antes fusionaría una rama
  // en la que alguien sigue escribiendo.
  if (corregir.length === 0 && !refactor) {
    cerrarTareaAprobada(db, bus, sourceTaskId);
  }

  return { findings: creados, reopened: corregir.length > 0, blocking, refactor_task: refactor };
}

/** Aprobación: no cambia el estado todavía; lo cierra `cerrarTareaAprobada` si no hay limpieza. */
function aprobar(db: Db, taskId: string): SystemEvent[] {
  requireTask(db, taskId);
  return [];
}

/**
 * Devuelve la tarea revisada a la cola con sus hallazgos, o la bloquea si ya ha agotado
 * las rondas de corrección que permite el proyecto.
 *
 * Sin el límite, un builder que nunca cumple la condición de resolución y un reviewer que
 * siempre la exige se pasarían la tarea indefinidamente gastando cuota (documento 07,
 * apartado 7.5).
 */
function devolverACorregir(db: Db, project: Project, taskId: string, hallazgos: Finding[]): SystemEvent[] {
  const task = requireTask(db, taskId);
  const peor = hallazgos.some((f) => f.severity === 'blocker') ? 'blocker' : 'major';

  addNotice(
    db,
    taskId,
    'reviewer',
    `El reviewer ha rechazado tu último incremento con ${hallazgos.length} hallazgos. Los tienes en tu encargo, con la condición para dar cada uno por resuelto.`,
  );

  if (task.status !== 'in_review') return [];

  const rechazados = db
    .prepare("SELECT COUNT(*) AS n FROM increments WHERE task_id = ? AND review_status = 'rejected'")
    .get(taskId) as { n: number };

  if (rechazados.n >= project.max_task_attempts) {
    return setStatusInternal(
      db,
      taskId,
      'blocked',
      `El reviewer ha rechazado ${rechazados.n} incrementos seguidos. El último con: ${hallazgos.map((f) => f.title).join('; ')}`,
    );
  }

  // La corrección entra por delante del trabajo nuevo: lo que ya está a medias se termina
  // antes de empezar otra cosa (requisito A04).
  const prioridad = Math.min(task.priority, PRIORIDAD_POR_GRAVEDAD[peor]);
  db.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?').run(prioridad, now(), taskId);

  return setStatusInternal(db, taskId, 'ready', `el reviewer ha abierto ${hallazgos.length} hallazgos que hay que corregir`);
}

/**
 * Cierra una tarea cuyo último incremento ha quedado aprobado y no espera limpieza.
 *
 * Si la tarea era un refactor, el trabajo que limpiaba también queda hecho, con el commit
 * del refactor como su commit final: es lo que se integrará.
 */
function cerrarTareaAprobada(db: Db, bus: EventBus, taskId: string): void {
  const eventos = inImmediateTransaction(db, () => {
    const task = requireTask(db, taskId);
    if (task.status !== 'in_review') return [];

    const propios = setStatusInternal(db, taskId, 'done', 'revisión aprobada');
    if (task.kind !== 'refactor' || !task.parent_task_id) return propios;

    return [...propios, ...cerrarTrasLimpiezaInternal(db, task.parent_task_id, task.head_commit)];
  });
  publishEvents(bus, eventos);
}

/** Cierra el trabajo que esperaba a su refactor, apuntando al commit final de la rama. */
function cerrarTrasLimpiezaInternal(db: Db, parentId: string, commitFinal: string | null): SystemEvent[] {
  const parent = requireTask(db, parentId);
  if (parent.status !== 'in_review') return [];

  if (commitFinal) {
    db.prepare('UPDATE tasks SET head_commit = ?, updated_at = ? WHERE id = ?').run(commitFinal, now(), parentId);
  }
  return setStatusInternal(db, parentId, 'done', 'revisión aprobada y limpieza terminada');
}

/**
 * Da por terminado un refactor que no dejó nada que revisar, o que se abandonó.
 *
 * El trabajo que esperaba a esa limpieza queda hecho con el commit que ya tenía aprobado.
 * Quien llama se encarga de que la rama vuelva a ese commit si el refactor dejó algo
 * encima (documento 07, apartado 7.6).
 */
export function cerrarTrasLimpieza(db: Db, bus: EventBus, refactorTaskId: string): void {
  const refactor = requireTask(db, refactorTaskId);
  if (refactor.kind !== 'refactor' || !refactor.parent_task_id) return;

  const eventos = inImmediateTransaction(db, () =>
    cerrarTrasLimpiezaInternal(
      db,
      refactor.parent_task_id!,
      // Solo un refactor aprobado mueve el commit final. Uno abandonado no.
      refactor.status === 'done' ? refactor.head_commit : null,
    ),
  );
  publishEvents(bus, eventos);
}

/**
 * Abre la tarea con la que el refactorer limpia un trabajo ya revisado y aprobado.
 *
 * Solo ocurre en modo estricto, y solo sobre trabajo que escribió código. Una tarea de
 * refactor no genera otra, porque si no la cadena no pararía nunca.
 */
function crearRefactorSiProcede(
  db: Db,
  bus: EventBus,
  sourceTask: Task,
  incrementId: string,
): Task | null {
  const project = requireProject(db, sourceTask.project_id);
  if (project.mode !== 'strict') return null;
  if (!PASAN_POR_REFACTORER.has(sourceTask.kind)) return null;

  const increment = db.prepare('SELECT * FROM increments WHERE id = ?').get(incrementId) as
    | Increment
    | undefined;
  if (!increment) return null;

  const refactor = createTask(db, bus, {
    project_id: sourceTask.project_id,
    parent_task_id: sourceTask.id,
    kind: 'refactor',
    title: `Limpiar: ${sourceTask.title}`,
    goal: `Mejorar el código del commit ${increment.commit_sha.slice(0, 8)} sin cambiar lo que hace: nombres, duplicación, funciones que mezclan cosas, comentarios obsoletos y código muerto.`,
    scope:
      'Solo lo que tocó el trabajo revisado. No añadas comportamiento nuevo ni cambies el existente. No toques los ficheros de prueba para que pasen.',
    acceptance:
      'La verificación del proyecto pasa igual que antes del cambio, y el comportamiento observable es el mismo.',
    required_role: 'refactorer',
    priority: Math.min(99, sourceTask.priority + 10),
    created_by: 'system',
    branch: increment.branch,
    base_commit: increment.commit_sha,
  });

  publishEvents(bus, [
    insertEvent(db, {
      project_id: sourceTask.project_id,
      type: 'task.status_changed',
      task_id: sourceTask.id,
      payload: {
        from: sourceTask.status,
        to: sourceTask.status,
        reason: 'revisión aprobada; espera a que el refactorer termine su limpieza',
        refactor_task_id: refactor.id,
      },
    }),
  ]);

  return refactor;
}

/**
 * Da por resueltos los hallazgos abiertos de una tarea que vienen de incrementos
 * anteriores al indicado. Se llama cuando el reviewer da un veredicto nuevo: lo que no
 * vuelve a abrir está resuelto.
 */
export function resolveOpenFindings(
  db: Db,
  bus: EventBus,
  taskId: string,
  exceptoIncrementId: string | null = null,
): Finding[] {
  const abiertos = (db
    .prepare("SELECT * FROM findings WHERE source_task_id = ? AND status = 'open'")
    .all(taskId) as Finding[]).filter((f) => f.increment_id !== exceptoIncrementId);

  const eventos: SystemEvent[] = [];
  for (const finding of abiertos) {
    db.prepare("UPDATE findings SET status = 'fixed', resolved_at = ? WHERE id = ?").run(now(), finding.id);
    eventos.push(
      insertEvent(db, {
        project_id: finding.project_id,
        type: 'finding.resolved',
        task_id: finding.source_task_id,
        payload: { finding_id: finding.id },
      }),
    );
  }

  publishEvents(bus, eventos);
  return abiertos;
}

export interface SystemFindingInput {
  task_id: string;
  title: string;
  detail: string;
  resolution: string;
}

/**
 * Abre un hallazgo bloqueante que no viene del reviewer sino del propio sistema, sobre el
 * último incremento de una tarea, y devuelve la tarea a la cola para que lo corrija.
 *
 * Lo usa la integración cuando la fusión pasa pero las verificaciones fallan.
 */
export function openSystemFinding(db: Db, bus: EventBus, input: SystemFindingInput): Finding {
  const task = requireTask(db, input.task_id);
  const project = requireProject(db, task.project_id);
  const incremento = db
    .prepare('SELECT * FROM increments WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(task.id) as Increment | undefined;
  if (!incremento) throw new RuleError(`La tarea ${task.id} no tiene ningún incremento sobre el que abrir un hallazgo.`);

  const id = newId('finding');
  const eventos = inImmediateTransaction(db, () => {
    db.prepare(
      `INSERT INTO findings (
         id, project_id, increment_id, source_task_id, severity, title, detail,
         resolution, status, created_at
       ) VALUES (?, ?, ?, ?, 'blocker', ?, ?, ?, 'open', ?)`,
    ).run(id, task.project_id, incremento.id, task.id, input.title, input.detail, input.resolution, now());

    db.prepare("UPDATE increments SET review_status = 'rejected' WHERE id = ?").run(incremento.id);

    const abierto = insertEvent(db, {
      project_id: task.project_id,
      type: 'finding.opened',
      task_id: task.id,
      payload: { finding_id: id, severity: 'blocker', title: input.title, review_task_id: null },
    });

    addNotice(db, task.id, 'system', `${input.title}. ${input.detail}`);

    const actual = requireTask(db, task.id);
    if (actual.status !== 'done' && actual.status !== 'in_review') return [abierto];

    db.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?').run(
      Math.min(actual.priority, PRIORIDAD_POR_GRAVEDAD.blocker),
      now(),
      task.id,
    );
    return [abierto, ...setStatusInternal(db, task.id, 'ready', input.title)];
  });

  publishEvents(bus, eventos);
  void project;
  return db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as Finding;
}

/** Hallazgos abiertos que impiden integrar una tarea. */
export function blockingFindings(db: Db, taskId: string): Finding[] {
  return db
    .prepare("SELECT * FROM findings WHERE source_task_id = ? AND status = 'open' AND severity = 'blocker'")
    .all(taskId) as Finding[];
}

export function listFindings(db: Db, taskId: string): Finding[] {
  return db
    .prepare('SELECT * FROM findings WHERE source_task_id = ? ORDER BY created_at')
    .all(taskId) as Finding[];
}

export function listIncrements(db: Db, taskId: string): Increment[] {
  return db
    .prepare('SELECT * FROM increments WHERE task_id = ? ORDER BY created_at')
    .all(taskId) as Increment[];
}

/** Tipos de tarea que comparten rama con la tarea que revisan o limpian, y por eso no se integran solas. */
const NO_SE_INTEGRAN = new Set(['review', 'refactor']);

/**
 * Decide si una tarea puede integrarse: está terminada, tiene un commit publicado y no
 * arrastra hallazgos bloqueantes (documento 07, apartado 7.8).
 */
export function readyToIntegrate(db: Db, taskId: string): { ready: boolean; reason?: string } {
  const task = requireTask(db, taskId);
  requireProject(db, task.project_id);

  // Una revisión o una limpieza comparte rama con la tarea sobre la que trabaja. Integrarla
  // sería fusionar dos veces lo mismo, o fusionar una limpieza a medias.
  if (NO_SE_INTEGRAN.has(task.kind)) {
    return { ready: false, reason: 'Una revisión o una limpieza no se integra: se integra la tarea sobre la que trabajó.' };
  }

  if (task.integrated_at) return { ready: false, reason: 'La tarea ya está integrada en la rama principal.' };
  if (task.status !== 'done') return { ready: false, reason: `La tarea está en estado ${task.status}.` };
  if (!task.head_commit) return { ready: false, reason: 'La tarea no ha publicado ningún commit.' };

  const bloqueantes = blockingFindings(db, taskId);
  if (bloqueantes.length > 0) {
    return { ready: false, reason: `Quedan ${bloqueantes.length} hallazgos bloqueantes abiertos.` };
  }
  return { ready: true };
}

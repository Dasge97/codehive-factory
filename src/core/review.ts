import type { Db } from './db.js';
import { inImmediateTransaction } from './db.js';
import { EventBus, insertEvent, publishEvents } from './events.js';
import { requireProject } from './projects.js';
import { RuleError, addNotice, createTask, requireTask, setStatusInternal } from './tasks.js';
import { newId, now } from '../shared/ids.js';
import type {
  Finding,
  FindingInput,
  Increment,
  SystemEvent,
  Task,
} from '../shared/types.js';

/** Prioridad con la que entra una corrección, según lo grave que sea el hallazgo. */
const PRIORIDAD_POR_GRAVEDAD = { blocker: 5, major: 20, minor: 60 } as const;

export interface PublishIncrementInput {
  task_id: string;
  run_id: string;
  commit_sha: string;
  branch: string;
  message: string;
  files: string[];
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
  fix_tasks: Task[];
  blocking: boolean;
}

/**
 * Registra los hallazgos de una revisión y abre una corrección por cada uno que lo
 * merezca.
 *
 * Los hallazgos leves se registran sin crear trabajo: si cada detalle menor abriera una
 * tarea, la cola de correcciones ahogaría al resto del proyecto.
 */
export function openFindings(db: Db, bus: EventBus, input: OpenFindingsInput): OpenFindingsResult {
  const reviewTask = requireTask(db, input.review_task_id);
  const sourceTaskId = reviewTask.parent_task_id;
  if (!sourceTaskId) {
    throw new RuleError(`La tarea de revisión ${reviewTask.id} no apunta a la tarea revisada.`);
  }
  const sourceTask = requireTask(db, sourceTaskId);

  const creados: Finding[] = [];
  const correcciones: Task[] = [];
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

    if (entrada.severity !== 'minor') {
      const correccion = createTask(db, bus, {
        project_id: reviewTask.project_id,
        parent_task_id: sourceTaskId,
        kind: 'fix',
        title: `Corregir: ${entrada.title}`,
        goal: entrada.detail,
        scope: `Corregir el hallazgo sobre el incremento ${input.increment_id}. No amplíes el alcance.`,
        acceptance: entrada.resolution,
        required_role: sourceTask.required_role,
        priority: PRIORIDAD_POR_GRAVEDAD[entrada.severity],
        created_by: 'system',
        branch: sourceTask.branch,
        base_commit: sourceTask.head_commit ?? sourceTask.base_commit,
      });

      db.prepare('UPDATE findings SET fix_task_id = ? WHERE id = ?').run(correccion.id, id);
      correcciones.push(correccion);

      // El aviso lo recibe la tarea original en su siguiente ejecución, no en la que
      // pueda tener en curso (decisión D12).
      addNotice(db, sourceTaskId, 'reviewer', `Hallazgo abierto: ${entrada.title}`);
    }

    eventos.push(
      insertEvent(db, {
        project_id: reviewTask.project_id,
        type: 'finding.opened',
        task_id: sourceTaskId,
        payload: {
          finding_id: id,
          severity: entrada.severity,
          title: entrada.title,
          fix_task_id: finding.fix_task_id,
          review_task_id: reviewTask.id,
        },
      }),
    );
  }

  const blocking = creados.some((f) => f.severity === 'blocker');

  // Aprobar el incremento de una corrección es lo que da por resuelto el hallazgo que la
  // originó. La aprobación de un incremento anterior no se traslada nunca a este.
  if (creados.length === 0 && sourceTask.kind === 'fix') {
    resolveFindingsOfFixTask(db, bus, sourceTask.id);
  }

  const eventosEstado = inImmediateTransaction(db, () => {
    db.prepare('UPDATE increments SET review_status = ? WHERE id = ?').run(
      creados.length === 0 ? 'approved' : 'rejected',
      input.increment_id,
    );

    const actual = requireTask(db, sourceTaskId);
    if (creados.length === 0 && actual.status === 'in_review') {
      return setStatusInternal(db, sourceTaskId, 'done', 'revisión sin hallazgos');
    }
    if (blocking && actual.status === 'in_review') {
      return setStatusInternal(db, sourceTaskId, 'ready', 'hallazgo bloqueante abierto');
    }
    return [];
  });

  publishEvents(bus, [...eventos, ...eventosEstado]);
  return { findings: creados, fix_tasks: correcciones, blocking };
}

/**
 * Da por resueltos los hallazgos que una corrección venía a arreglar. Se llama cuando el
 * reviewer aprueba el incremento que produjo esa corrección.
 */
export function resolveFindingsOfFixTask(db: Db, bus: EventBus, fixTaskId: string): Finding[] {
  const abiertos = db
    .prepare("SELECT * FROM findings WHERE fix_task_id = ? AND status = 'open'")
    .all(fixTaskId) as Finding[];

  const eventos: SystemEvent[] = [];
  for (const finding of abiertos) {
    db.prepare("UPDATE findings SET status = 'fixed', resolved_at = ? WHERE id = ?").run(now(), finding.id);
    eventos.push(
      insertEvent(db, {
        project_id: finding.project_id,
        type: 'finding.resolved',
        task_id: finding.source_task_id,
        payload: { finding_id: finding.id, fix_task_id: fixTaskId },
      }),
    );
  }

  publishEvents(bus, eventos);
  return abiertos;
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

/**
 * Decide si una tarea puede integrarse: está terminada, tiene un commit publicado y no
 * arrastra hallazgos bloqueantes (documento 07, apartado 7.7).
 */
export function readyToIntegrate(db: Db, taskId: string): { ready: boolean; reason?: string } {
  const task = requireTask(db, taskId);
  requireProject(db, task.project_id);

  if (task.status !== 'done') return { ready: false, reason: `La tarea está en estado ${task.status}.` };
  if (!task.head_commit) return { ready: false, reason: 'La tarea no ha publicado ningún commit.' };

  const bloqueantes = blockingFindings(db, taskId);
  if (bloqueantes.length > 0) {
    return { ready: false, reason: `Quedan ${bloqueantes.length} hallazgos bloqueantes abiertos.` };
  }
  return { ready: true };
}

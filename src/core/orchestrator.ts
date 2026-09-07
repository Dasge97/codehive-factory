import { z } from 'zod';
import type { Db } from './db.js';
import { EventBus, appendEvent } from './events.js';
import { agentForRole, currentDecisions, currentRevision, listAgents, recordDecision, requireProject, setProjectGoal } from './projects.js';
import { blockingFindings, listFindings } from './review.js';
import { integrableTasks } from './integration.js';
import { conversacionActual, ponerTituloSiFalta, tocarConversacion } from './conversations.js';
import { createTask, listTasks, requireTask, setPriority, setStatus } from './tasks.js';
import { queueForRole, razonDeEspera } from './queue.js';
import { newId, now } from '../shared/ids.js';
import {
  AGENT_ROLES,
  TASK_KINDS,
  type AgentRole,
  type ChatMessage,
  type ProjectMode,
  type Task,
} from '../shared/types.js';

/**
 * Plan que devuelve el orquestador.
 *
 * El orquestador no ejecuta acciones una a una: recibe el estado completo del proyecto y
 * devuelve de una vez lo que hay que cambiar. El sistema aplica el plan con código normal,
 * así que cada cambio pasa por las mismas validaciones que cualquier otro (decisión D24).
 */
export const orchestratorPlanSchema = z.object({
  reply: z.string().min(1),
  project_goal: z.string().nullable().optional(),
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        goal: z.string().min(1),
        kind: z.enum(TASK_KINDS),
        role: z.enum(AGENT_ROLES),
        scope: z.string().nullable().optional(),
        acceptance: z.string().nullable().optional(),
        priority: z.number().int().min(1).max(100).nullable().optional(),
        path_patterns: z.array(z.string()).nullable().optional(),
        depends_on: z.array(z.string()).nullable().optional(),
        needs_review: z.boolean().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  decisions: z
    .array(z.object({ title: z.string().min(1), body: z.string().min(1), supersedes_title: z.string().nullable().optional() }))
    .nullable()
    .optional(),
  priority_changes: z
    .array(z.object({ task_id: z.string(), priority: z.number().int().min(1).max(100) }))
    .nullable()
    .optional(),
  cancellations: z
    .array(z.object({ task_id: z.string(), reason: z.string().min(1) }))
    .nullable()
    .optional(),
});

export type OrchestratorPlan = z.infer<typeof orchestratorPlanSchema>;

/** El mismo plan en JSON Schema, que es lo que entiende el motor. */
export const ORCHESTRATOR_PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Respuesta para el creador, en lenguaje llano.' },
    project_goal: {
      type: ['string', 'null'],
      description: 'Objetivo actual del proyecto, o null si no ha cambiado.',
    },
    tasks: {
      type: ['array', 'null'],
      description: 'Tareas nuevas, o null. Cada una debe poder ejecutarse sin volver a preguntar.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título corto y concreto.' },
          goal: { type: 'string', description: 'Qué resultado se espera.' },
          kind: { type: 'string', enum: ['build', 'review', 'fix', 'research', 'refactor'] },
          role: { type: 'string', enum: ['builder', 'reviewer', 'researcher', 'refactorer'] },
          scope: { type: ['string', 'null'], description: 'Qué queda fuera de esta tarea.' },
          acceptance: { type: ['string', 'null'], description: 'Criterios comprobables de aceptación.' },
          priority: { type: ['number', 'null'], description: 'De 1 a 100. Menor número, antes se ejecuta.' },
          path_patterns: {
            type: ['array', 'null'],
            description:
              'Ficheros que va a modificar, como patrones. Dos tareas con los mismos ficheros no pueden ir a la vez.',
            items: { type: 'string' },
          },
          depends_on: {
            type: ['array', 'null'],
            description:
              'Títulos de otras tareas de este mismo plan, o identificadores de tareas existentes, que deben terminar antes.',
            items: { type: 'string' },
          },
          needs_review: {
            type: ['boolean', 'null'],
            description:
              'Si lo que produzca esta tarea necesita pasar por el reviewer. false solo para documentación, comentarios o código nuevo que todavía no usa nadie. Ante la duda, true.',
          },
        },
        required: [
          'title', 'goal', 'kind', 'role', 'scope', 'acceptance', 'priority',
          'path_patterns', 'depends_on', 'needs_review',
        ],
        additionalProperties: false,
      },
    },
    decisions: {
      type: ['array', 'null'],
      description: 'Decisiones de producto que hay que dejar registradas, o null.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          supersedes_title: {
            type: ['string', 'null'],
            description: 'Título de la decisión anterior que queda sustituida, o null.',
          },
        },
        required: ['title', 'body', 'supersedes_title'],
        additionalProperties: false,
      },
    },
    priority_changes: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        properties: { task_id: { type: 'string' }, priority: { type: 'number' } },
        required: ['task_id', 'priority'],
        additionalProperties: false,
      },
    },
    cancellations: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        properties: { task_id: { type: 'string' }, reason: { type: 'string' } },
        required: ['task_id', 'reason'],
        additionalProperties: false,
      },
    },
  },
  // Todas las propiedades van en `required` porque Codex lo exige; las que no se usan van
  // a null (decisión D35).
  required: ['reply', 'project_goal', 'tasks', 'decisions', 'priority_changes', 'cancellations'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Estado que se entrega al orquestador
// ---------------------------------------------------------------------------

/** Cuánto de lo que escribió un agente cabe en el encargo del orquestador. */
const LARGO_DEL_RESULTADO = 400;

/** Lo que escribió el agente al terminar la última ejecución de una tarea. */
function ultimoResultado(db: Db, taskId: string): string | null {
  const fila = db
    .prepare(
      `SELECT summary FROM runs
       WHERE task_id = ? AND summary IS NOT NULL AND summary <> ''
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(taskId) as { summary: string } | undefined;
  return fila?.summary ?? null;
}

/** Recorta un texto sin cortar a mitad de palabra si se puede evitar. */
function recortar(texto: string | null, maximo: number): string | null {
  if (!texto) return null;
  const limpio = texto.replace(/\s+/g, ' ').trim();
  if (limpio.length <= maximo) return limpio;

  const corte = limpio.lastIndexOf(' ', maximo);
  return `${limpio.slice(0, corte > maximo * 0.6 ? corte : maximo)}…`;
}

export interface ProjectSnapshot {
  goal: string | null;
  revision: number;
  decisions: Array<{ title: string; body: string; revision: number }>;
  tasks: Array<{
    id: string;
    title: string;
    kind: string;
    role: AgentRole;
    status: string;
    priority: number;
    blocked_reason: string | null;
    waiting_for: string | null;
    open_blockers: number;
    /**
     * Lo que el agente escribió al terminar su última ejecución.
     *
     * Sin esto, el orquestador ve que una tarea está hecha pero no qué se hizo, así que
     * no puede contárselo al creador ni decidir qué falta.
     */
    last_result: string | null;
  }>;
  /**
   * Tareas cuyo trabajo ya está en la rama principal.
   *
   * Van aparte y solo con su título. Lo que hicieron ya está integrado, así que su resumen
   * no ayuda a decidir nada y era lo que más ocupaba del encargo en un proyecto con
   * muchas tareas hechas.
   */
  integrated: Array<{ id: string; title: string }>;
  /** Hallazgos abiertos del reviewer, con lo que hace falta para darlos por resueltos. */
  findings: Array<{
    task_id: string;
    task_title: string;
    severity: string;
    title: string;
    resolution: string;
  }>;
  /** Trabajo terminado y revisado que espera a que el creador lo integre. */
  integrable: Array<{ id: string; title: string; branch: string }>;
  team: Array<{ name: string; role: AgentRole; busy: boolean; queue: number }>;
  /** Modo de trabajo del proyecto: en estricto se recorre la cadena entera. */
  mode: ProjectMode;
  chat: Array<{ author: string; body: string }>;
  pending_approvals: Array<{ id: string; task_id: string; request: string }>;
}

/** Reúne el estado del proyecto que el orquestador necesita para decidir. */
export function projectSnapshot(db: Db, projectId: string, chatLimit = 20): ProjectSnapshot {
  const project = requireProject(db, projectId);

  const vivas = listTasks(db, projectId).filter((t) => t.status !== 'cancelled');

  // Lo ya integrado se separa: va aparte y sin resumen.
  const integradas = vivas.filter((t) => t.integrated_at !== null);
  const abiertas = vivas.filter((t) => t.integrated_at === null);

  const tareas = abiertas.map((t) => ({
    id: t.id,
    title: t.title,
    kind: t.kind,
    role: t.required_role,
    status: t.status,
    priority: t.priority,
    blocked_reason: t.blocked_reason,
    waiting_for: t.status === 'ready' ? razonDeEspera(db, t.id) : null,
    open_blockers: blockingFindings(db, t.id).length,
    last_result: recortar(ultimoResultado(db, t.id), LARGO_DEL_RESULTADO),
  }));

  const hallazgos = abiertas.flatMap((t) =>
    listFindings(db, t.id)
      .filter((f) => f.status === 'open')
      .map((f) => ({
        task_id: t.id,
        task_title: t.title,
        severity: f.severity,
        title: f.title,
        resolution: f.resolution,
      })),
  );

  const equipo = listAgents(db, projectId).map((a) => {
    const ocupado = db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status = 'running'")
      .get(a.id) as { n: number };
    return {
      name: a.name,
      role: a.role,
      busy: ocupado.n >= a.max_workers,
      queue: queueForRole(db, projectId, a.role).length,
    };
  });

  // Solo la conversación abierta. Es lo que hace que empezar una nueva sirva de algo: sin
  // este filtro, el orquestador seguiría viendo todo lo hablado desde el primer día.
  const chat = (db
    .prepare(
      'SELECT author, body FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(conversacionActual(db, projectId).id, chatLimit) as Array<{
    author: string;
    body: string;
  }>).reverse();

  const aprobaciones = db
    .prepare(
      `SELECT a.id, a.task_id, a.request FROM approvals a
       JOIN tasks t ON t.id = a.task_id
       WHERE t.project_id = ? AND a.status = 'pending'`,
    )
    .all(projectId) as Array<{ id: string; task_id: string; request: string }>;

  return {
    goal: project.goal,
    mode: project.mode,
    integrated: integradas.map((t) => ({ id: t.id, title: t.title })),
    findings: hallazgos,
    integrable: integrableTasks(db, projectId).map((t) => ({
      id: t.id,
      title: t.title,
      branch: t.branch,
    })),
    revision: currentRevision(db, projectId),
    decisions: currentDecisions(db, projectId).map((d) => ({ title: d.title, body: d.body, revision: d.revision })),
    tasks: tareas,
    team: equipo,
    chat,
    pending_approvals: aprobaciones,
  };
}

/** Redacta el encargo del orquestador a partir del estado del proyecto. */
export function renderOrchestratorPrompt(snapshot: ProjectSnapshot, mensajeNuevo: string): string {
  const partes: string[] = ['# Estado del proyecto'];

  partes.push(snapshot.goal ? `Objetivo actual: ${snapshot.goal}` : 'El proyecto todavía no tiene un objetivo escrito.');

  partes.push(
    snapshot.mode === 'strict'
      ? 'Modo estricto: todo lo que deje un commit se revisa y después pasa por el refactorer. Tu marca de revisión se ignora.'
      : 'Modo normal: tú decides qué necesita revisión, con el criterio de tus instrucciones.',
  );

  if (snapshot.decisions.length > 0) {
    partes.push(
      '\n## Decisiones vigentes\n' +
        snapshot.decisions.map((d) => `### ${d.title} (revisión ${d.revision})\n${d.body}`).join('\n\n'),
    );
  }

  if (snapshot.tasks.length > 0) {
    partes.push(
      '\n## Tareas\n' +
        snapshot.tasks
          .map((t) => {
            const notas = [
              t.blocked_reason ? `bloqueada: ${t.blocked_reason}` : null,
              t.waiting_for ? `esperando: ${t.waiting_for}` : null,
              t.open_blockers > 0 ? `${t.open_blockers} hallazgos bloqueantes` : null,
            ].filter(Boolean);
            const cabecera = `- [${t.id}] ${t.title} — ${t.kind}/${t.role}, estado ${t.status}, prioridad ${t.priority}${notas.length ? `. ${notas.join('. ')}` : ''}`;

            // Lo que escribió el agente al terminar va en su propia línea, sangrada, para
            // que se distinga de los datos de la tarea.
            return t.last_result ? `${cabecera}\n  Dijo el agente: ${t.last_result}` : cabecera;
          })
          .join('\n'),
    );
  } else {
    partes.push('\n## Tareas\nNo hay ninguna tarea todavía.');
  }

  if (snapshot.findings.length > 0) {
    partes.push(
      '\n## Hallazgos abiertos del reviewer\n' +
        snapshot.findings
          .map(
            (f) =>
              `- [${f.task_id}] ${f.task_title} — ${f.severity}: ${f.title}. Se da por resuelto cuando: ${f.resolution}`,
          )
          .join('\n'),
    );
  }

  if (snapshot.integrated.length > 0) {
    partes.push(
      '\n## Ya integrado en la rama principal\n' +
        snapshot.integrated.map((t) => `- [${t.id}] ${t.title}`).join('\n'),
    );
  }

  if (snapshot.integrable.length > 0) {
    partes.push(
      '\n## Trabajo revisado que espera a que el creador lo integre\n' +
        snapshot.integrable.map((t) => `- [${t.id}] ${t.title} — rama ${t.branch}`).join('\n'),
    );
  }

  partes.push(
    '\n## Equipo\n' +
      snapshot.team.map((a) => `- ${a.name} (${a.role}): ${a.busy ? 'ocupado' : 'libre'}, ${a.queue} tareas en su cola`).join('\n'),
  );

  if (snapshot.pending_approvals.length > 0) {
    partes.push(
      '\n## Autorizaciones pendientes del creador\n' +
        snapshot.pending_approvals.map((a) => `- [${a.id}] sobre la tarea ${a.task_id}: ${a.request}`).join('\n'),
    );
  }

  if (snapshot.chat.length > 0) {
    partes.push('\n## Conversación reciente\n' + snapshot.chat.map((m) => `${m.author}: ${m.body}`).join('\n'));
  }

  partes.push(`\n## Mensaje nuevo del creador\n${mensajeNuevo}`);
  partes.push(
    '\n## Qué tienes que devolver\nUn plan con tu respuesta al creador y los cambios que haya que hacer. ' +
      'Crea solo tareas que otro agente pueda ejecutar sin volver a preguntar. ' +
      'Si dos tareas van a tocar los mismos ficheros, o las unes o pones una como dependencia de la otra.',
  );

  return partes.join('\n');
}

// ---------------------------------------------------------------------------
// Aplicación del plan
// ---------------------------------------------------------------------------

export interface ApplyPlanResult {
  created_tasks: Task[];
  reply: ChatMessage | null;
  errors: string[];
}

/**
 * Aplica el plan del orquestador.
 *
 * Cada cambio pasa por las funciones normales del sistema, así que un plan que pida algo
 * imposible falla en esa parte concreta y el resto del plan se aplica igual. Los errores
 * se devuelven para que el orquestador los vea en su siguiente turno.
 */
export function applyPlan(db: Db, bus: EventBus, projectId: string, plan: OrchestratorPlan): ApplyPlanResult {
  const errores: string[] = [];
  const creadas: Task[] = [];
  const porTitulo = new Map<string, string>();

  if (plan.project_goal) {
    setProjectGoal(db, projectId, plan.project_goal);
  }

  for (const decision of plan.decisions ?? []) {
    try {
      const anterior = decision.supersedes_title
        ? currentDecisions(db, projectId).find((d) => d.title === decision.supersedes_title)
        : undefined;

      const guardada = recordDecision(db, {
        project_id: projectId,
        title: decision.title,
        body: decision.body,
        decided_by: 'orchestrator',
        supersedes_id: anterior?.id ?? null,
      });

      // Un cambio de decisión marca para reevaluar el trabajo que se creó con la revisión
      // anterior. El trabajo compatible sigue sin tocarse (documento 07, apartado 7.8).
      if (anterior) {
        db.prepare(
          `UPDATE tasks SET needs_reeval = 1, updated_at = ?
           WHERE project_id = ? AND decision_revision < ? AND status NOT IN ('done','cancelled')`,
        ).run(now(), projectId, guardada.revision);
      }

      appendEvent(db, bus, {
        project_id: projectId,
        type: 'decision.recorded',
        payload: { decision_id: guardada.id, title: guardada.title, revision: guardada.revision },
      });
    } catch (e) {
      errores.push(`No se pudo registrar la decisión "${decision.title}": ${mensaje(e)}`);
    }
  }

  const revision = currentRevision(db, projectId);

  // Primera pasada: crear las tareas sin dependencias entre sí, para poder resolver
  // después las que se refieren unas a otras por su título.
  for (const entrada of plan.tasks ?? []) {
    try {
      const task = createTask(db, bus, {
        project_id: projectId,
        kind: entrada.kind,
        title: entrada.title,
        goal: entrada.goal,
        scope: entrada.scope ?? null,
        acceptance: entrada.acceptance ?? null,
        required_role: entrada.role,
        priority: entrada.priority ?? 50,
        path_patterns: entrada.path_patterns ?? [],
        created_by: 'orchestrator',
        decision_revision: revision || 1,
        // Sin marca explícita, se revisa. Que el orquestador se olvide del campo no puede
        // significar que el trabajo pase sin revisar.
        needs_review: entrada.needs_review !== false,
      });
      porTitulo.set(entrada.title, task.id);
      creadas.push(task);
    } catch (e) {
      errores.push(`No se pudo crear la tarea "${entrada.title}": ${mensaje(e)}`);
    }
  }

  // Segunda pasada: enlazar dependencias, ya sea por título dentro del plan o por
  // identificador de una tarea que ya existía.
  for (const entrada of plan.tasks ?? []) {
    const id = porTitulo.get(entrada.title);
    if (!id) continue;

    for (const referencia of entrada.depends_on ?? []) {
      const destino = porTitulo.get(referencia) ?? referencia;
      try {
        db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run(id, destino);
      } catch {
        errores.push(`La tarea "${entrada.title}" no pudo depender de "${referencia}".`);
      }
    }
  }

  // Una tarea que acaba de recibir dependencias tiene que volver a pendiente.
  for (const task of creadas) {
    const abiertas = db
      .prepare(
        `SELECT COUNT(*) AS n FROM task_dependencies d
         JOIN tasks dep ON dep.id = d.depends_on_id
         WHERE d.task_id = ? AND dep.status NOT IN ('done','cancelled')`,
      )
      .get(task.id) as { n: number };

    if (abiertas.n > 0 && requireTask(db, task.id).status === 'ready') {
      setStatus(db, bus, task.id, 'pending', 'tiene dependencias abiertas');
    }
  }

  for (const cambio of plan.priority_changes ?? []) {
    try {
      setPriority(db, bus, cambio.task_id, cambio.priority);
    } catch (e) {
      errores.push(`No se pudo cambiar la prioridad de ${cambio.task_id}: ${mensaje(e)}`);
    }
  }

  for (const cancelacion of plan.cancellations ?? []) {
    try {
      setStatus(db, bus, cancelacion.task_id, 'cancelled', cancelacion.reason);
    } catch (e) {
      errores.push(`No se pudo cancelar ${cancelacion.task_id}: ${mensaje(e)}`);
    }
  }

  const reply = plan.reply ? postChatMessage(db, bus, projectId, 'orchestrator', plan.reply) : null;

  return { created_tasks: creadas.map((t) => requireTask(db, t.id)), reply, errors: errores };
}

function mensaje(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export function postChatMessage(
  db: Db,
  bus: EventBus,
  projectId: string,
  author: string,
  body: string,
  taskId: string | null = null,
): ChatMessage {
  // Cada mensaje pertenece a la conversación abierta. El orquestador solo ve esa, así que
  // empezar una nueva deja fuera lo hablado antes sin borrarlo.
  const conversacion = conversacionActual(db, projectId);

  const id = newId('chatMessage');
  db.prepare(
    `INSERT INTO chat_messages (id, project_id, conversation_id, author, body, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, conversacion.id, author, body, taskId, now());

  // El título sale del primer mensaje de la persona, que es lo que sirve para reconocer
  // la conversación en la lista.
  if (author === 'creator') ponerTituloSiFalta(db, conversacion.id, body);
  tocarConversacion(db, conversacion.id);

  const mensaje = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as ChatMessage;

  appendEvent(db, bus, {
    project_id: projectId,
    type: 'chat.message',
    task_id: taskId,
    payload: { message_id: id, author, body },
  });

  return mensaje;
}

/** Los mensajes de la conversación abierta. Las anteriores se piden por su identificador. */
export function listChat(db: Db, projectId: string, limit = 100): ChatMessage[] {
  return listChatDeConversacion(db, conversacionActual(db, projectId).id, limit);
}

/** Los mensajes de una conversación concreta, para poder volver a una anterior. */
export function listChatDeConversacion(db: Db, conversationId: string, limit = 100): ChatMessage[] {
  return (db
    .prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(conversationId, limit) as ChatMessage[]).reverse();
}

/** Comprueba que el proyecto tiene un agente orquestador configurado. */
export function orchestratorAgent(db: Db, projectId: string) {
  return agentForRole(db, projectId, 'orchestrator');
}

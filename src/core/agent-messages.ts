import type { Db } from './db.js';
import { EventBus, appendEvent } from './events.js';
import { agentForRole, listAgents } from './projects.js';
import { createTask, requireTask } from './tasks.js';
import { queueForRole } from './queue.js';
import { newId, now } from '../shared/ids.js';
import type { AgentRole, Task } from '../shared/types.js';

/** Formas de ayuda entre agentes (documento 06, apartado 6.2). */
export const MESSAGE_KINDS = ['question', 'notice', 'help_request', 'answer', 'escalation'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface AgentMessage {
  id: string;
  project_id: string;
  thread_id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  kind: MessageKind;
  body: string;
  task_id: string | null;
  delivered_at: string | null;
  created_at: string;
}

/**
 * Cuántos mensajes puede tener una conversación antes de escalarla.
 *
 * Dos agentes que no llegan a nada pueden seguir contestándose sin producir ningún
 * resultado. El límite corta ese caso y lleva el asunto al orquestador.
 */
export const MAX_MENSAJES_POR_CONVERSACION = 6;

export interface SendMessageInput {
  project_id: string;
  from_agent_id: string;
  kind: MessageKind;
  body: string;
  to_agent_id?: string | null;
  task_id?: string | null;
  thread_id?: string | null;
}

export interface SendMessageResult {
  message: AgentMessage;
  escalated: boolean;
}

/**
 * Envía un mensaje de un agente a otro, o a todo el equipo.
 *
 * Si la conversación supera el límite de mensajes sin producir un resultado, el mensaje se
 * marca como escalado y se avisa al orquestador con lo que se ha dicho hasta ahora.
 */
export function sendAgentMessage(db: Db, bus: EventBus, input: SendMessageInput): SendMessageResult {
  const threadId = input.thread_id ?? newId('agentMessage');
  const id = newId('agentMessage');

  const enElHilo = db
    .prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE thread_id = ?')
    .get(threadId) as { n: number };

  const escalar = enElHilo.n + 1 > MAX_MENSAJES_POR_CONVERSACION && input.kind !== 'escalation';
  const kind: MessageKind = escalar ? 'escalation' : input.kind;

  db.prepare(
    `INSERT INTO agent_messages (id, project_id, thread_id, from_agent_id, to_agent_id, kind, body, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.project_id,
    threadId,
    input.from_agent_id,
    escalar ? (agentForRole(db, input.project_id, 'orchestrator')?.id ?? null) : (input.to_agent_id ?? null),
    kind,
    escalar
      ? `La conversación llegó al límite de ${MAX_MENSAJES_POR_CONVERSACION} mensajes sin conclusión. Último mensaje: ${input.body}`
      : input.body,
    input.task_id ?? null,
    now(),
  );

  const message = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as AgentMessage;

  appendEvent(db, bus, {
    project_id: input.project_id,
    type: 'run.progress',
    task_id: input.task_id ?? null,
    agent_id: input.from_agent_id,
    payload: { kind: 'notice', text: `Mensaje entre agentes (${kind}): ${message.body.slice(0, 200)}` },
  });

  return { message, escalated: escalar };
}

/** Mensajes de una conversación, del más antiguo al más reciente. */
export function threadMessages(db: Db, threadId: string): AgentMessage[] {
  return db
    .prepare('SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY created_at')
    .all(threadId) as AgentMessage[];
}

/** Mensajes que un agente todavía no ha recibido. */
export function pendingForAgent(db: Db, agentId: string): AgentMessage[] {
  return db
    .prepare(
      `SELECT * FROM agent_messages
       WHERE (to_agent_id = ? OR to_agent_id IS NULL) AND delivered_at IS NULL
       ORDER BY created_at`,
    )
    .all(agentId) as AgentMessage[];
}

export function markDelivered(db: Db, agentId: string): void {
  db.prepare(
    'UPDATE agent_messages SET delivered_at = ? WHERE (to_agent_id = ? OR to_agent_id IS NULL) AND delivered_at IS NULL',
  ).run(now(), agentId);
}

/**
 * Convierte una petición de apoyo en una tarea con responsable.
 *
 * Ayudar no es hacer el trabajo del otro sin dejar rastro: si la ayuda requiere ejecutar
 * algo, se crea una tarea con su propio responsable (documento 06, apartado 6.2).
 */
export function helpRequestToTask(
  db: Db,
  bus: EventBus,
  input: { project_id: string; from_agent_id: string; to_role: AgentRole; body: string; task_id: string },
): Task {
  const origen = requireTask(db, input.task_id);

  const apoyo = createTask(db, bus, {
    project_id: input.project_id,
    parent_task_id: input.task_id,
    kind: input.to_role === 'researcher' ? 'research' : 'build',
    title: `Apoyo para "${origen.title}"`,
    goal: input.body,
    scope: 'Responder solo a lo que se pide. El trabajo principal sigue siendo de la tarea que lo pidió.',
    acceptance: 'La respuesta permite continuar la tarea que pidió el apoyo sin volver a preguntar.',
    required_role: input.to_role,
    // Entra por delante de la tarea que la pidió: mientras no se resuelva, esa tarea no avanza.
    priority: Math.max(1, origen.priority - 10),
    created_by: input.from_agent_id,
  });

  sendAgentMessage(db, bus, {
    project_id: input.project_id,
    from_agent_id: input.from_agent_id,
    kind: 'help_request',
    body: input.body,
    task_id: input.task_id,
  });

  return apoyo;
}

export interface TeamEntry {
  agent_id: string;
  name: string;
  role: AgentRole;
  engine: string;
  available: boolean;
  busy_workers: number;
  max_workers: number;
  queue_length: number;
  current_tasks: Array<{ id: string; title: string }>;
}

/**
 * Directorio del equipo que cualquier agente puede consultar.
 *
 * Es lo que hace concreto el requisito A06: un agente sabe quién más existe, qué sabe
 * hacer y si está libre, sin tener que leer el historial de nadie.
 */
export function teamDirectory(db: Db, projectId: string): TeamEntry[] {
  return listAgents(db, projectId).map((agent) => {
    const activas = db
      .prepare(
        `SELECT t.id, t.title FROM runs r
         JOIN tasks t ON t.id = r.task_id
         WHERE r.agent_id = ? AND r.status = 'running'`,
      )
      .all(agent.id) as Array<{ id: string; title: string }>;

    return {
      agent_id: agent.id,
      name: agent.name,
      role: agent.role,
      engine: agent.engine,
      available: activas.length < agent.max_workers && agent.enabled === 1,
      busy_workers: activas.length,
      max_workers: agent.max_workers,
      queue_length: queueForRole(db, projectId, agent.role).length,
      current_tasks: activas,
    };
  });
}

/** El directorio del equipo escrito para que lo lea un agente en su encargo. */
export function renderTeamDirectory(equipo: TeamEntry[]): string {
  return equipo
    .map((a) => {
      const estado = a.available ? 'disponible' : 'ocupado';
      const trabajo = a.current_tasks.length > 0 ? `, ahora con "${a.current_tasks[0]!.title}"` : '';
      return `- ${a.name} (${a.role}, ${a.engine}): ${estado}${trabajo}. ${a.queue_length} tareas en su cola.`;
    })
    .join('\n');
}

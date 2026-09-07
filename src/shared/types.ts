import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enumeraciones del dominio. Los valores coinciden con los del documento 04.
// ---------------------------------------------------------------------------

export const AGENT_ROLES = [
  'orchestrator',
  'builder',
  'reviewer',
  'researcher',
  'refactorer',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const ENGINES = ['claude_code', 'codex'] as const;
export type EngineName = (typeof ENGINES)[number];

export const TASK_KINDS = ['build', 'review', 'fix', 'research', 'integrate', 'refactor'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/**
 * Modo de trabajo del proyecto.
 *
 * En `normal` el orquestador decide qué necesita revisión, y el sistema impone un suelo
 * que no puede saltarse. En `strict` se recorre la cadena entera: todo lo que deja un
 * commit se revisa, y después pasa por el refactorer.
 *
 * El modo se graba en la tarea al crearla. Cambiar de modo no afecta a lo que ya está en
 * marcha.
 */
export const PROJECT_MODES = ['normal', 'strict'] as const;
export type ProjectMode = (typeof PROJECT_MODES)[number];

export const TASK_STATUSES = [
  'pending',
  'ready',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'timed_out',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_STATUSES = ['open', 'fixed', 'dismissed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const APPROVAL_STATUSES = ['pending', 'granted', 'denied', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Estados desde los que una tarea ya no vuelve a ejecutarse. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['done', 'cancelled'];

// ---------------------------------------------------------------------------
// Filas de la base de datos
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  repo_path: string;
  main_branch: string;
  goal: string | null;
  verify_command: string | null;
  install_command: string | null;
  max_concurrent_runs: number;
  max_task_attempts: number;
  run_timeout_ms: number;
  status: 'active' | 'paused' | 'archived';
  mode: ProjectMode;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  project_id: string;
  name: string;
  role: AgentRole;
  engine: EngineName;
  model: string | null;
  instructions: string;
  allowed_tools: string;
  max_workers: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  kind: TaskKind;
  title: string;
  goal: string;
  scope: string | null;
  acceptance: string | null;
  required_role: AgentRole;
  priority: number;
  status: TaskStatus;
  assigned_agent_id: string | null;
  active_run_id: string | null;
  branch: string | null;
  workspace_path: string | null;
  base_commit: string | null;
  head_commit: string | null;
  decision_revision: number;
  needs_reeval: number;
  /**
   * El orquestador cree que lo que produzca esta tarea necesita revisión.
   *
   * Es una decisión, no una garantía: aunque valga 0, el sistema revisa igual si la
   * verificación del proyecto no pasó o si el agente terminó a medias.
   */
  needs_review: number;
  attempts: number;
  blocked_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Run {
  id: string;
  task_id: string;
  agent_id: string;
  worker_id: string;
  engine: EngineName;
  engine_session_id: string | null;
  status: RunStatus;
  input_commit: string | null;
  output_commit: string | null;
  summary: string | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  started_at: string;
  ended_at: string | null;
}

export interface Increment {
  id: string;
  task_id: string;
  run_id: string;
  commit_sha: string;
  branch: string;
  message: string;
  files_json: string | null;
  review_status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

export interface Finding {
  id: string;
  project_id: string;
  increment_id: string;
  source_task_id: string;
  fix_task_id: string | null;
  severity: FindingSeverity;
  title: string;
  detail: string;
  resolution: string;
  file_path: string | null;
  line: number | null;
  status: FindingStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface Decision {
  id: string;
  project_id: string;
  revision: number;
  title: string;
  body: string;
  supersedes_id: string | null;
  decided_by: string;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  project_id: string;
  author: string;
  body: string;
  task_id: string | null;
  created_at: string;
}

export interface ResourceLock {
  id: string;
  project_id: string;
  task_id: string;
  path_pattern: string;
  acquired_at: string;
  released_at: string | null;
}

export interface Approval {
  id: string;
  run_id: string;
  task_id: string;
  kind: string;
  request: string;
  tool_name: string | null;
  tool_input: string | null;
  status: ApprovalStatus;
  responded_by: string | null;
  created_at: string;
  responded_at: string | null;
}

// ---------------------------------------------------------------------------
// Eventos. Cada cambio de estado publica uno. La web se dibuja a partir de ellos.
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'task.created',
  'task.status_changed',
  'task.blocked',
  'run.started',
  'run.progress',
  'run.finished',
  'increment.published',
  // El incremento se ha publicado sin abrir revisión, porque en modo normal el
  // orquestador marcó que no hacía falta y el cambio pasó la verificación del proyecto.
  'review.skipped',
  'finding.opened',
  'finding.resolved',
  'approval.requested',
  'approval.resolved',
  'decision.recorded',
  'chat.message',
  'integration.completed',
  'quota.exhausted',
  'usage.updated',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface SystemEvent {
  id: number;
  project_id: string;
  type: EventType;
  task_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  payload: string;
  created_at: string;
}

/** Un evento antes de guardarse: sin identificador y con la carga sin serializar. */
export interface NewEvent {
  project_id: string;
  type: EventType;
  task_id?: string | null;
  run_id?: string | null;
  agent_id?: string | null;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Contrato de resultado del agente (documento 05, apartado 5.2).
// El esquema se pasa al motor con --json-schema y se vuelve a validar al recibirlo.
// ---------------------------------------------------------------------------

export const findingInputSchema = z.object({
  severity: z.enum(FINDING_SEVERITIES),
  title: z.string().min(1),
  detail: z.string().min(1),
  resolution: z.string().min(1),
  file_path: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
});
export type FindingInput = z.infer<typeof findingInputSchema>;

export const agentResultSchema = z.object({
  outcome: z.enum(['completed', 'partial', 'blocked', 'failed']),
  summary: z.string().min(1),
  commit: z.string().nullable().optional(),
  verification: z
    .object({
      ran: z.boolean(),
      command: z.string().nullable().optional(),
      passed: z.boolean().nullable().optional(),
      output_excerpt: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  findings: z.array(findingInputSchema).nullable().optional(),
  questions: z.array(z.string()).nullable().optional(),
  needs: z.array(z.string()).nullable().optional(),
});
export type AgentResult = z.infer<typeof agentResultSchema>;

/**
 * El mismo contrato en JSON Schema, que es lo que entiende la opción --json-schema del
 * motor. Se escribe a mano para que el motor reciba exactamente lo que el sistema
 * valida, sin depender de una conversión automática.
 */
export const AGENT_RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    outcome: {
      type: 'string',
      enum: ['completed', 'partial', 'blocked', 'failed'],
      description:
        'completed si la tarea queda cumplida, partial si avanzó sin terminar, blocked si algo la impide, failed si no se pudo hacer.',
    },
    summary: {
      type: 'string',
      description: 'Qué se ha hecho, en lenguaje llano. Es lo que lee el creador.',
    },
    commit: {
      type: ['string', 'null'],
      description: 'Identificador del commit publicado, o null si la tarea no tocaba código.',
    },
    verification: {
      type: ['object', 'null'],
      description: 'Resultado del comando de verificación del proyecto, o null si no se ejecutó.',
      properties: {
        ran: { type: 'boolean' },
        command: { type: ['string', 'null'] },
        passed: { type: ['boolean', 'null'] },
        output_excerpt: { type: ['string', 'null'] },
      },
      required: ['ran', 'command', 'passed', 'output_excerpt'],
      additionalProperties: false,
    },
    findings: {
      type: ['array', 'null'],
      description: 'Solo lo rellena el reviewer. Un elemento por problema detectado, o null.',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          resolution: { type: 'string' },
          file_path: { type: ['string', 'null'] },
          line: { type: ['number', 'null'] },
        },
        required: ['severity', 'title', 'detail', 'resolution', 'file_path', 'line'],
        additionalProperties: false,
      },
    },
    questions: {
      type: ['array', 'null'],
      description: 'Preguntas que bloquean el trabajo y necesitan respuesta, o null.',
      items: { type: 'string' },
    },
    needs: {
      type: ['array', 'null'],
      description: 'Peticiones de apoyo a otro rol, o null. Cada una genera una tarea nueva.',
      items: { type: 'string' },
    },
  },
  // Codex exige que todas las propiedades estén en `required`; las que no se usan van a
  // null. Claude Code acepta el mismo esquema, así que uno solo vale para los dos motores.
  required: ['outcome', 'summary', 'commit', 'verification', 'findings', 'questions', 'needs'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Encargo entregado a un agente (documento 05, apartado 5.1).
// ---------------------------------------------------------------------------

export interface Assignment {
  task: Pick<Task, 'id' | 'kind' | 'title' | 'goal' | 'scope' | 'acceptance' | 'priority'>;
  project: Pick<Project, 'id' | 'name' | 'goal' | 'main_branch' | 'verify_command'>;
  workspace: { path: string; branch: string; base_commit: string } | null;
  decisions: Array<Pick<Decision, 'title' | 'body' | 'revision'>>;
  dependencies: Array<{ id: string; title: string; status: TaskStatus; result: string | null }>;
  locks: string[];
  findings: Array<Pick<Finding, 'id' | 'severity' | 'title' | 'detail' | 'resolution'>>;
  team: Array<{ agent_id: string; name: string; role: AgentRole; available: boolean }>;
  notices: Array<{ from: string; body: string }>;
  previous_run: { id: string; summary: string | null; engine_session_id: string | null } | null;
}

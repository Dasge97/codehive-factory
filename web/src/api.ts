import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Formas de los datos que devuelve la API. Se declaran aquí porque la web no
// comparte compilación con el servidor.
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'pending' | 'ready' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';

export type AgentRole = 'orchestrator' | 'builder' | 'reviewer' | 'researcher' | 'refactorer';

/**
 * Modo de trabajo del proyecto.
 *
 * En normal el orquestador decide qué se revisa. En estricto se revisa todo y el trabajo
 * aprobado pasa además por el refactorer.
 */
export type ProjectMode = 'normal' | 'strict';

export interface Task {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  kind: string;
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
  head_commit: string | null;
  attempts: number;
  blocked_reason: string | null;
  needs_reeval: number;
  created_at: string;
  updated_at: string;
  waiting_for?: string | null;
  findings_open?: number;
}

export interface AgentView {
  id: string;
  name: string;
  role: AgentRole;
  engine: string;
  model: string | null;
  allowed_tools: string[];
  max_workers: number;
  enabled: number;
  busy_workers: number;
  current_tasks: string[];
  queue_length: number;
}

/** Qué sabe hacer realmente un motor. La web solo ofrece lo que aquí se declara. */
export interface EngineCapabilities {
  resumeSession: boolean;
  resultSchema: boolean;
  usageReporting: boolean;
  costReporting: boolean;
  budgetLimit: boolean;
  permissionDenials: boolean;
  stop: boolean;
}

export interface MotoresDisponibles {
  available: Array<{ name: string; capabilities: EngineCapabilities }>;
  unavailable: Array<{ engine: string; reason: string }>;
}

export interface Run {
  id: string;
  task_id: string;
  status: string;
  summary: string | null;
  error: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  started_at: string;
  ended_at: string | null;
}

export interface Increment {
  id: string;
  commit_sha: string;
  branch: string;
  message: string;
  files_json: string | null;
  review_status: string;
  created_at: string;
}

export interface Finding {
  id: string;
  severity: 'blocker' | 'major' | 'minor';
  title: string;
  detail: string;
  resolution: string;
  file_path: string | null;
  line: number | null;
  status: string;
  fix_task_id: string | null;
  created_at: string;
}

export interface Approval {
  id: string;
  task_id: string;
  request: string;
  tool_name: string | null;
  tool_input: string | null;
  status: string;
  created_at: string;
}

export interface EngineUsage {
  engine: string;
  status: string;
  five_hour_util: number | null;
  five_hour_resets: string | null;
  seven_day_util: number | null;
  seven_day_resets: string | null;
  using_overage: number;
  updated_at: string;
}

/**
 * Una conversación con el orquestador.
 *
 * Un proyecto tiene varias y solo una abierta. El orquestador solo ve la abierta, así que
 * empezar una nueva deja fuera lo hablado antes sin borrarlo.
 */
export interface ConversationView {
  id: string;
  project_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  messages: number;
  last_message_at: string | null;
  is_current: number;
}

export interface ChatMessage {
  id: string;
  author: string;
  body: string;
  created_at: string;
}

export interface SystemEvent {
  id: number;
  project_id: string;
  type: string;
  task_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  payload: string;
  created_at: string;
}

/** Una carpeta que el sistema ya tiene registrada. */
export interface ProyectoRegistrado {
  id: string;
  name: string;
  repo_path: string;
  status: string;
}

/** Lo que devuelve el explorador de carpetas. */
export interface CarpetaListada {
  path: string;
  /** Carpeta de arriba, o null si ya se está en la raíz de la unidad. */
  parent: string | null;
  is_git_repo: boolean;
  entries: Array<{ name: string; path: string; is_git_repo: boolean }>;
  /** Unidades del equipo, para saltar de una a otra. */
  roots: string[];
  /** El equipo puede abrir el diálogo de carpetas del sistema. */
  native_picker: boolean;
}

/**
 * Lo que cuesta hablar con el orquestador.
 *
 * Cada mensaje lanza una ejecución del motor con el estado del proyecto entero, así que el
 * tamaño del encargo crece con el número de tareas. Los tokens solo llegan de los motores
 * que los informan; Codex no lo hace.
 */
export interface TurnosDelOrquestador {
  resumen: {
    turnos: number;
    ultimo_encargo: number | null;
    encargo_medio: number | null;
    entrada_media: number | null;
    salida_media: number | null;
    coste_total: number | null;
  };
  turnos: Array<{
    id: string;
    engine: string;
    status: string;
    prompt_chars: number;
    input_tokens: number | null;
    output_tokens: number | null;
    started_at: string;
  }>;
}

export interface ProjectOverview {
  project: {
    id: string;
    name: string;
    goal: string | null;
    repo_path: string;
    main_branch: string;
    verify_command: string | null;
    install_command: string | null;
    max_concurrent_runs: number;
    max_task_attempts: number;
    status: string;
    mode: ProjectMode;
    /** 1 si los motores usan la configuración personal de quien arranca el sistema. */
    use_personal_config: number;
  };
  snapshot: {
    goal: string | null;
    decisions: Array<{ title: string; body: string; revision: number }>;
    pending_approvals: Array<{ id: string; task_id: string; request: string }>;
  };
  integrable: Array<{ id: string; title: string; branch: string; commit: string }>;
  usage: EngineUsage[];
  active_work: Array<{ task_id: string; run_id: string; agent_id: string; role: AgentRole }>;
  /** El orquestador tiene un turno en marcha ahora mismo. */
  orchestrator_busy: boolean;
}

export interface TaskDetail {
  task: Task;
  waiting_for: string | null;
  runs: Run[];
  increments: Increment[];
  findings: Finding[];
  integrable: { ready: boolean; reason?: string };
  approvals: Approval[];
  notices: Array<{ id: string; from_actor: string; body: string; delivered_at: string | null }>;
  dependencies: Array<{ id: string; title: string; status: TaskStatus }>;
  locks: Array<{ id: string; path_pattern: string; released_at: string | null }>;
}

// ---------------------------------------------------------------------------
// Llamadas
// ---------------------------------------------------------------------------

/**
 * Un error del servidor que además pide una confirmación.
 *
 * Se usa cuando la respuesta no es «no se puede» sino «se puede, pero conviene que lo
 * sepas antes». La web enseña el motivo y un botón para seguir.
 */
export class NecesitaConfirmar extends Error {
  constructor(
    mensaje: string,
    readonly files: number,
  ) {
    super(mensaje);
    this.name = 'NecesitaConfirmar';
  }
}

async function pedir<T>(ruta: string, opciones?: RequestInit): Promise<T> {
  const respuesta = await fetch(`/api${ruta}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opciones,
  });
  const cuerpo = (await respuesta.json().catch(() => null)) as
    | { error?: string; needs_confirmation?: boolean; files?: number }
    | null;

  if (!respuesta.ok) {
    const mensaje = cuerpo?.error ?? `Error ${respuesta.status}`;
    if (cuerpo?.needs_confirmation) throw new NecesitaConfirmar(mensaje, cuerpo.files ?? 0);
    throw new Error(mensaje);
  }
  return cuerpo as T;
}

export const api = {
  proyectos: () => pedir<ProyectoRegistrado[]>('/projects'),

  /** Carpetas que hay dentro de una ruta, para elegir cuál abrir. */
  explorar: (ruta?: string) =>
    pedir<CarpetaListada>(`/browse${ruta ? `?path=${encodeURIComponent(ruta)}` : ''}`),

  /**
   * Abre el diálogo de carpetas del sistema y espera a que se elija una.
   *
   * La ventana sale en el equipo donde corre el servicio. Devuelve la ruta, o null si se
   * cancela.
   */
  selectorNativo: (inicio?: string) =>
    pedir<{ path: string | null; cancelled: boolean }>('/browse/native', {
      method: 'POST',
      body: JSON.stringify({ path: inicio ?? '' }),
    }),

  /** Abre una carpeta. A partir de aquí el equipo trabaja sobre ella. */
  abrirCarpeta: (ruta: string, confirm = false) =>
    pedir<ProyectoRegistrado>('/projects/open', {
      method: 'POST',
      body: JSON.stringify({ path: ruta, confirm }),
    }),
  proyecto: (id: string) => pedir<ProjectOverview>(`/projects/${id}`),
  tareas: (id: string) => pedir<Task[]>(`/projects/${id}/tasks`),
  agentes: (id: string) => pedir<AgentView[]>(`/projects/${id}/agents`),
  chat: (id: string) => pedir<ChatMessage[]>(`/projects/${id}/chat`),
  actividad: (id: string, limite = 40) => pedir<SystemEvent[]>(`/projects/${id}/activity?limit=${limite}`),
  detalle: (taskId: string) => pedir<TaskDetail>(`/tasks/${taskId}`),

  enviarMensaje: (id: string, body: string) =>
    pedir<ChatMessage>(`/projects/${id}/chat`, { method: 'POST', body: JSON.stringify({ body }) }),

  cambiarPrioridad: (taskId: string, priority: number) =>
    pedir<Task>(`/tasks/${taskId}/priority`, { method: 'POST', body: JSON.stringify({ priority }) }),

  cancelar: (taskId: string, reason: string) =>
    pedir<Task>(`/tasks/${taskId}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),

  integrar: (taskId: string) =>
    pedir<{ integrated: boolean; reason: string; conflicts?: string[] }>(`/tasks/${taskId}/integrate`, {
      method: 'POST',
    }),

  pararEjecucion: (runId: string) =>
    pedir<{ requested: boolean; found: boolean }>(`/runs/${runId}/stop`, { method: 'POST' }),

  responderAutorizacion: (id: string, granted: boolean) =>
    pedir<Approval>(`/approvals/${id}`, { method: 'POST', body: JSON.stringify({ granted }) }),

  motores: () => pedir<MotoresDisponibles>('/engines'),

  pararOrquestador: (id: string) =>
    pedir<{ requested: boolean; running: boolean }>(`/projects/${id}/orchestrator/stop`, {
      method: 'POST',
    }),

  pausarProyecto: (id: string, paused: boolean) =>
    pedir<{ status: string }>(`/projects/${id}/pause`, { method: 'POST', body: JSON.stringify({ paused }) }),

  cambiarConfiguracionPersonal: (id: string, usar: boolean) =>
    pedir<{ use_personal_config: number }>(`/projects/${id}/personal-config`, {
      method: 'POST',
      body: JSON.stringify({ use_personal_config: usar }),
    }),

  conversaciones: (id: string) => pedir<ConversationView[]>(`/projects/${id}/conversations`),

  nuevaConversacion: (id: string) =>
    pedir<ConversationView>(`/projects/${id}/conversations`, { method: 'POST' }),

  abrirConversacion: (id: string, conversationId: string) =>
    pedir<ConversationView>(`/projects/${id}/conversations/${conversationId}/open`, {
      method: 'POST',
    }),

  turnosDelOrquestador: (id: string) =>
    pedir<TurnosDelOrquestador>(`/projects/${id}/orchestrator/turns`),

  cambiarModo: (id: string, mode: ProjectMode) =>
    pedir<{ mode: ProjectMode }>(`/projects/${id}/mode`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),

  cambiarMotor: (agentId: string, engine: string) =>
    pedir<AgentView>(`/agents/${agentId}/engine`, { method: 'POST', body: JSON.stringify({ engine }) }),

  cambiarWorkers: (agentId: string, max_workers: number) =>
    pedir<AgentView>(`/agents/${agentId}/workers`, { method: 'POST', body: JSON.stringify({ max_workers }) }),

  activarAgente: (agentId: string, enabled: boolean) =>
    pedir<AgentView>(`/agents/${agentId}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }),
};

// ---------------------------------------------------------------------------
// Eventos en vivo
// ---------------------------------------------------------------------------

export type EstadoConexion = 'conectando' | 'conectado' | 'desconectado';

/**
 * Escucha los eventos del proyecto.
 *
 * Al reconectar pide desde el último evento recibido, así que no se pierde nada. Mientras
 * está desconectada, la web dice que la información puede estar desactualizada en lugar de
 * fingir que sigue al día.
 */
export function useEventos(projectId: string | null, alRecibir: (evento: SystemEvent) => void) {
  const [estado, setEstado] = useState<EstadoConexion>('conectando');
  const ultimoId = useRef(0);
  const alRecibirRef = useRef(alRecibir);
  alRecibirRef.current = alRecibir;

  useEffect(() => {
    if (!projectId) return;

    const fuente = new EventSource(`/api/projects/${projectId}/events?since=${ultimoId.current}`);

    fuente.onopen = () => setEstado('conectado');

    fuente.onmessage = (mensaje) => {
      setEstado('conectado');
      try {
        const evento = JSON.parse(mensaje.data) as SystemEvent;
        if (evento.id > ultimoId.current) ultimoId.current = evento.id;
        alRecibirRef.current(evento);
      } catch {
        // Una línea mal formada no debe tumbar la conexión.
      }
    };

    fuente.onerror = () => setEstado('desconectado');

    return () => fuente.close();
  }, [projectId]);

  return estado;
}

/** Carga datos y los vuelve a pedir cuando se le indica. */
export function useCarga<T>(cargar: () => Promise<T>, deps: unknown[]): {
  datos: T | null;
  error: string | null;
  recargar: () => void;
} {
  const [datos, setDatos] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const cargarRef = useRef(cargar);
  cargarRef.current = cargar;

  useEffect(() => {
    let vigente = true;
    cargarRef
      .current()
      .then((r) => {
        if (vigente) {
          setDatos(r);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (vigente) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);

  const recargar = useCallback(() => setVersion((v) => v + 1), []);
  return { datos, error, recargar };
}

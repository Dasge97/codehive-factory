import type { EngineName } from '../shared/types.js';

/** Qué se le pide a un motor para una ejecución. */
export interface EngineRunRequest {
  /** El encargo completo, ya redactado. Se envía por la entrada estándar del proceso. */
  prompt: string;
  /** Directorio de trabajo. Es el worktree de la tarea. */
  cwd: string;
  /** Herramientas que puede usar el agente. Lista vacía significa ninguna. */
  allowedTools: string[];
  /** Tiempo máximo antes de matar el proceso (decisión D23). */
  timeoutMs: number;
  model?: string | null;
  /** Esquema JSON que debe cumplir el resultado (decisión D21). */
  resultSchema?: unknown;
  /** Identificador con el que abrir una sesión nueva. */
  sessionId?: string | null;
  /** Identificador de una sesión anterior que se quiere continuar. */
  resumeSessionId?: string | null;
  /** Instrucciones del rol, que se añaden a las propias del motor. */
  systemPromptAppend?: string | null;
  /** Techo de gasto de la ejecución, si el motor lo admite. */
  maxBudgetUsd?: number | null;
  /** Modo de permisos del motor. */
  /**
   * `default` es el modo normal del motor: pregunta antes de escribir o ejecutar, y como
   * nadie contesta, se deniega. Es el que usa el orquestador, que solo lee.
   */
  permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions' | 'plan';
  /**
   * Si el motor se lanza con la configuración personal de quien arranca el sistema: su
   * CLAUDE.md, sus hooks, sus ficheros de ajustes y sus servidores MCP. Por omisión no.
   */
  usePersonalConfig?: boolean;
}

/** Un paso del trabajo del agente, tal como lo publica el motor. */
export interface EngineProgress {
  kind: 'message' | 'tool_use' | 'tool_result' | 'notice';
  text: string;
  tool?: string | undefined;
  isError?: boolean | undefined;
}

/** Una acción que el motor no ejecutó porque necesitaba permiso. */
export interface PermissionDenial {
  tool_name: string;
  tool_input: unknown;
}

/** Consumo de la suscripción que publica el motor (apartado 11.6). */
export interface EngineUsageReport {
  status: string;
  fiveHourUtilization: number | null;
  fiveHourResetsAt: string | null;
  sevenDayUtilization: number | null;
  sevenDayResetsAt: string | null;
  usingOverage: boolean;
}

export type EngineRunStatus = 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

/** Lo que queda de una ejecución cuando termina. */
export interface EngineRunOutcome {
  status: EngineRunStatus;
  sessionId: string | null;
  /** Texto devuelto por el agente. Con esquema, es el JSON del resultado sin convertir. */
  resultText: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  permissionDenials: PermissionDenial[];
  /** Motivo del final que informa el motor. `api_error` señala fallo de credenciales o de la API. */
  terminalReason: string | null;
  usage: EngineUsageReport | null;
  error: string | null;
}

/** Una ejecución en marcha. */
export interface EngineHandle {
  /** Espera a que la ejecución termine. */
  wait(): Promise<EngineRunOutcome>;
  /** Detiene la ejecución. El resultado será `cancelled`. */
  stop(): void;
  /**
   * Identificador del proceso del motor, si el motor es un proceso. Se guarda con la
   * ejecución para poder matar un proceso huérfano tras un reinicio del sistema.
   */
  pid?: number;
}

/** Qué sabe hacer realmente un motor. La web solo ofrece lo que aquí se declara. */
export interface EngineCapabilities {
  /** Puede continuar una conversación anterior. */
  resumeSession: boolean;
  /** Puede validar el resultado contra un esquema JSON. */
  resultSchema: boolean;
  /** Informa del consumo de la suscripción. */
  usageReporting: boolean;
  /** Informa del coste de cada ejecución. */
  costReporting: boolean;
  /** Admite un techo de gasto por ejecución. */
  budgetLimit: boolean;
  /** Informa de las acciones que denegó por falta de permiso. */
  permissionDenials: boolean;
  /** Se puede detener a mitad. */
  stop: boolean;
}

export interface Engine {
  readonly name: EngineName;
  capabilities(): EngineCapabilities;
  /**
   * Lanza un encargo mínimo de verdad y comprueba que vuelve un resultado que cumple un
   * esquema. Es lo que distingue «el ejecutable existe» de «el motor funciona con estas
   * opciones y esta cuenta». Se ejecuta al arrancar (tarea F3-01 del documento 13).
   */
  probe?(): Promise<{ ok: boolean; error?: string }>;
  start(request: EngineRunRequest, onProgress?: (p: EngineProgress) => void): EngineHandle;
  /** Comprueba que el motor está instalado y utilizable. Devuelve su versión. */
  check(): Promise<{ ok: boolean; version?: string; error?: string }>;
}

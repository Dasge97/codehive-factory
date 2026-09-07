import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  Engine,
  EngineCapabilities,
  EngineHandle,
  EngineProgress,
  EngineRunOutcome,
  EngineRunRequest,
  EngineUsageReport,
  PermissionDenial,
} from './types.js';
import { describirResultado, describirUsoDeHerramienta, recortar } from './progreso.js';

const execFileAsync = promisify(execFile);

/**
 * Busca el ejecutable de Claude Code.
 *
 * Se prefiere el ejecutable nativo `claude.exe`. Lanzar el guion `claude.cmd` sin shell da
 * un error EINVAL en Node 22 sobre Windows, y usar shell corrompe los prompts largos con
 * comillas (apartado 11.3 del documento de capacidades).
 */
export function resolveClaudePath(): string | null {
  const desdeEntorno = process.env['CODEHIVE_CLAUDE_PATH'];
  if (desdeEntorno && existsSync(desdeEntorno)) return desdeEntorno;

  const candidatos =
    process.platform === 'win32'
      ? [join(homedir(), '.local', 'bin', 'claude.exe')]
      : [join(homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];

  for (const ruta of candidatos) {
    if (existsSync(ruta)) return ruta;
  }
  return null;
}

/** Lee líneas completas de un flujo que llega a trozos. */
class LineSplitter {
  private resto = '';

  push(chunk: string, onLine: (line: string) => void): void {
    this.resto += chunk;
    let corte: number;
    while ((corte = this.resto.indexOf('\n')) !== -1) {
      const linea = this.resto.slice(0, corte).trim();
      this.resto = this.resto.slice(corte + 1);
      if (linea) onLine(linea);
    }
  }

  flush(onLine: (line: string) => void): void {
    const linea = this.resto.trim();
    this.resto = '';
    if (linea) onLine(linea);
  }
}

function segundosAIso(segundos: unknown): string | null {
  return typeof segundos === 'number' ? new Date(segundos * 1000).toISOString() : null;
}

export class ClaudeCodeEngine implements Engine {
  readonly name = 'claude_code' as const;

  constructor(private readonly executablePath: string) {}

  static create(): ClaudeCodeEngine {
    const ruta = resolveClaudePath();
    if (!ruta) {
      throw new Error(
        'No se encuentra el ejecutable de Claude Code. Instálalo o indica su ruta en la variable de entorno CODEHIVE_CLAUDE_PATH.',
      );
    }
    return new ClaudeCodeEngine(ruta);
  }

  capabilities(): EngineCapabilities {
    return {
      resumeSession: true,
      resultSchema: true,
      usageReporting: true,
      costReporting: true,
      budgetLimit: true,
      permissionDenials: true,
      stop: true,
    };
  }

  async check(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const { stdout } = await execFileAsync(this.executablePath, ['--version'], { timeout: 30_000 });
      return { ok: true, version: stdout.trim() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Argumentos de la línea de órdenes. Público para poder comprobarlo sin lanzar el motor. */
  buildArgs(request: EngineRunRequest): string[] {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      // Sin esta opción, los servidores MCP del equipo siguen disponibles para el agente
      // aunque se restrinjan las herramientas (apartado 11.3).
      '--strict-mcp-config',
      // Nadie puede responder a un prompt de permiso, así que lo que necesite permiso se
      // deniega y queda registrado para que decida el creador (decisión D22).
      '--permission-prompts', 'none',
      '--permission-mode', request.permissionMode ?? 'acceptEdits',
      '--tools', request.allowedTools.join(','),
    ];

    if (request.model) args.push('--model', request.model);
    if (request.resultSchema) args.push('--json-schema', JSON.stringify(request.resultSchema));
    if (request.systemPromptAppend) args.push('--append-system-prompt', request.systemPromptAppend);
    if (typeof request.maxBudgetUsd === 'number') args.push('--max-budget-usd', String(request.maxBudgetUsd));

    if (request.resumeSessionId) args.push('--resume', request.resumeSessionId);
    else if (request.sessionId) args.push('--session-id', request.sessionId);

    return args;
  }

  start(request: EngineRunRequest, onProgress?: (p: EngineProgress) => void): EngineHandle {
    const args = this.buildArgs(request);

    // Sin shell: con shell activado, un prompt largo con comillas llega cortado al motor
    // y el agente responde a un encargo incompleto, sin dar ningún error (apartado 11.3).
    const proceso: ChildProcess = spawn(this.executablePath, args, {
      cwd: request.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const estado = new RunState(request, onProgress);
    const terminado = estado.attach(proceso, request.timeoutMs);

    return {
      wait: () => terminado,
      stop: () => estado.stop(),
    };
  }
}

/** Acumula lo que publica el motor durante una ejecución y arma el resultado final. */
export class RunState {
  private readonly stdout = new LineSplitter();
  private sessionId: string | null = null;
  private resultText: string | null = null;
  private costUsd: number | null = null;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private terminalReason: string | null = null;
  private permissionDenials: PermissionDenial[] = [];
  private usage: EngineUsageReport | null = null;
  private stderr = '';
  private vioResultado = false;
  private detenidoPorPeticion = false;
  private agotadoPorTiempo = false;
  private proceso: ChildProcess | null = null;

  constructor(
    private readonly request: EngineRunRequest,
    private readonly onProgress?: (p: EngineProgress) => void,
  ) {}

  attach(proceso: ChildProcess, timeoutMs: number): Promise<EngineRunOutcome> {
    this.proceso = proceso;

    // La entrada estándar se cierra siempre. Si se deja abierta, el motor espera tres
    // segundos antes de continuar (apartado 11.3).
    proceso.stdin?.write(this.request.prompt);
    proceso.stdin?.end();

    proceso.stdout?.setEncoding('utf8');
    proceso.stdout?.on('data', (chunk: string) => {
      this.stdout.push(chunk, (linea) => this.handleLine(linea));
    });

    proceso.stderr?.setEncoding('utf8');
    proceso.stderr?.on('data', (chunk: string) => {
      this.stderr += chunk;
    });

    const temporizador = setTimeout(() => {
      this.agotadoPorTiempo = true;
      this.kill();
    }, timeoutMs);

    return new Promise<EngineRunOutcome>((resolve) => {
      proceso.on('error', (error) => {
        clearTimeout(temporizador);
        resolve(this.outcome('failed', error.message));
      });

      proceso.on('close', (code) => {
        clearTimeout(temporizador);
        this.stdout.flush((linea) => this.handleLine(linea));
        resolve(this.finalOutcome(code));
      });
    });
  }

  stop(): void {
    this.detenidoPorPeticion = true;
    this.kill();
  }

  private kill(): void {
    this.proceso?.kill('SIGTERM');
  }

  handleLine(linea: string): void {
    let evento: Record<string, unknown>;
    try {
      evento = JSON.parse(linea) as Record<string, unknown>;
    } catch {
      return; // Una línea que no es JSON no aporta nada; el motor a veces escribe avisos.
    }

    switch (evento['type']) {
      case 'system':
        if (typeof evento['session_id'] === 'string') this.sessionId = evento['session_id'];
        break;

      case 'rate_limit_event':
        this.usage = this.parseUsage(evento['rate_limit_info']);
        break;

      case 'assistant':
        this.reportAssistant(evento['message']);
        break;

      case 'user':
        this.reportToolResults(evento['message']);
        break;

      case 'result':
        this.vioResultado = true;
        this.readResult(evento);
        break;

      default:
        break;
    }
  }

  private parseUsage(info: unknown): EngineUsageReport | null {
    if (!info || typeof info !== 'object') return null;
    const i = info as Record<string, unknown>;
    const ventanas = (i['unifiedWindows'] ?? {}) as Record<string, { utilization?: number; resetsAt?: number }>;
    return {
      status: typeof i['status'] === 'string' ? i['status'] : 'unknown',
      fiveHourUtilization: ventanas['five_hour']?.utilization ?? null,
      fiveHourResetsAt: segundosAIso(ventanas['five_hour']?.resetsAt),
      sevenDayUtilization: ventanas['seven_day']?.utilization ?? null,
      sevenDayResetsAt: segundosAIso(ventanas['seven_day']?.resetsAt),
      usingOverage: i['isUsingOverage'] === true,
    };
  }

  private reportAssistant(message: unknown): void {
    if (!this.onProgress || !message || typeof message !== 'object') return;
    const bloques = (message as { content?: unknown }).content;
    if (!Array.isArray(bloques)) return;

    for (const bloque of bloques as Array<Record<string, unknown>>) {
      if (bloque['type'] === 'text' && typeof bloque['text'] === 'string') {
        // Lo que el agente dice es lo que hay que leer, así que no se recorta a una
        // frase. El límite es solo para que un volcado enorme no llene el panel.
        this.onProgress({ kind: 'message', text: recortar(bloque['text'], 1500) });
      } else if (bloque['type'] === 'tool_use') {
        // El objeto entero de argumentos no lo lee nadie: se cuenta qué hace la
        // herramienta, con el fichero o el comando que toca.
        const herramienta = typeof bloque['name'] === 'string' ? bloque['name'] : 'una herramienta';
        this.onProgress({
          kind: 'tool_use',
          text: describirUsoDeHerramienta(herramienta, bloque['input']),
          tool: typeof bloque['name'] === 'string' ? bloque['name'] : undefined,
        });
      }
    }
  }

  private reportToolResults(message: unknown): void {
    if (!this.onProgress || !message || typeof message !== 'object') return;
    const bloques = (message as { content?: unknown }).content;
    if (!Array.isArray(bloques)) return;

    for (const bloque of bloques as Array<Record<string, unknown>>) {
      if (bloque['type'] !== 'tool_result') continue;
      const contenido = bloque['content'];
      const esError = bloque['is_error'] === true;
      this.onProgress({
        kind: 'tool_result',
        text: describirResultado(
          typeof contenido === 'string' ? contenido : JSON.stringify(contenido ?? ''),
          esError,
        ),
        isError: esError,
      });
    }
  }

  private readResult(evento: Record<string, unknown>): void {
    if (typeof evento['session_id'] === 'string') this.sessionId = evento['session_id'];
    if (typeof evento['result'] === 'string') this.resultText = evento['result'];
    if (typeof evento['total_cost_usd'] === 'number') this.costUsd = evento['total_cost_usd'];
    if (typeof evento['terminal_reason'] === 'string') this.terminalReason = evento['terminal_reason'];

    const uso = evento['usage'];
    if (uso && typeof uso === 'object') {
      const u = uso as Record<string, unknown>;
      if (typeof u['input_tokens'] === 'number') this.inputTokens = u['input_tokens'];
      if (typeof u['output_tokens'] === 'number') this.outputTokens = u['output_tokens'];
    }

    const denegaciones = evento['permission_denials'];
    if (Array.isArray(denegaciones)) {
      this.permissionDenials = denegaciones
        .filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === 'object')
        .map((d) => ({
          tool_name: typeof d['tool_name'] === 'string' ? d['tool_name'] : 'desconocida',
          tool_input: d['tool_input'] ?? null,
        }));
    }
  }

  /**
   * Decide en qué estado terminó la ejecución.
   *
   * La ausencia del evento de resultado significa que el proceso no llegó al final: se
   * mató, se agotó el tiempo o se cayó (apartado 11.5).
   */
  private finalOutcome(code: number | null): EngineRunOutcome {
    if (this.agotadoPorTiempo) {
      return this.outcome('timed_out', `La ejecución superó el tiempo máximo de ${this.request.timeoutMs} ms.`);
    }
    if (this.detenidoPorPeticion) {
      return this.outcome('cancelled', 'La ejecución se detuvo a petición.');
    }
    if (!this.vioResultado) {
      return this.outcome('failed', `El motor terminó con código ${code} sin publicar un resultado. ${this.stderr.slice(0, 500)}`.trim());
    }
    if (this.terminalReason === 'api_error') {
      return this.outcome('failed', 'El motor no pudo hablar con la API: credenciales, cuota o red.');
    }
    if (code !== 0) {
      return this.outcome('failed', `El motor terminó con código ${code}. ${this.stderr.slice(0, 500)}`.trim());
    }
    return this.outcome('succeeded', null);
  }

  outcome(status: EngineRunOutcome['status'], error: string | null): EngineRunOutcome {
    return {
      status,
      sessionId: this.sessionId,
      resultText: this.resultText,
      costUsd: this.costUsd,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      permissionDenials: this.permissionDenials,
      terminalReason: this.terminalReason,
      usage: this.usage,
      error,
    };
  }
}

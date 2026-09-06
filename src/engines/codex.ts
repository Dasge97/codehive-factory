import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  Engine,
  EngineCapabilities,
  EngineHandle,
  EngineProgress,
  EngineRunOutcome,
  EngineRunRequest,
} from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Busca el ejecutable nativo de Codex.
 *
 * Igual que con Claude Code, hay que usar el binario y no el guion de arranque: con el
 * `.cmd` de npm hace falta shell, y entonces la señal de parada mata el intérprete pero no
 * el proceso de Codex, que sigue trabajando y gastando cuota.
 */
export function resolveCodexPath(): string | null {
  const desdeEntorno = process.env['CODEHIVE_CODEX_PATH'];
  if (desdeEntorno && existsSync(desdeEntorno)) return desdeEntorno;

  const npmGlobal = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex');
  const candidatos =
    process.platform === 'win32'
      ? [
          join(npmGlobal, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
        ]
      : [
          join(homedir(), '.npm-global', 'bin', 'codex'),
          '/usr/local/bin/codex',
          '/opt/homebrew/bin/codex',
        ];

  for (const ruta of candidatos) {
    if (existsSync(ruta)) return ruta;
  }
  return null;
}

/**
 * Decide si el agente necesita poder ejecutar órdenes.
 *
 * En Windows, el aislamiento propio de Codex rechaza el lanzamiento de PowerShell, así que
 * con cualquiera de sus modos de sandbox el agente no puede ejecutar nada: ni consultar el
 * historial de Git ni lanzar las pruebas. Un reviewer que no puede mirar el commit ni
 * ejecutar las verificaciones no sirve de nada, así que se ejecuta fuera de ese sandbox
 * (decisión D38). El aislamiento real lo da el worktree, igual que con Claude Code.
 */
function necesitaEjecutarOrdenes(modo: EngineRunRequest['permissionMode']): boolean {
  return modo !== 'plan';
}

export class CodexEngine implements Engine {
  readonly name = 'codex' as const;

  constructor(private readonly executablePath: string) {}

  static create(): CodexEngine {
    const ruta = resolveCodexPath();
    if (!ruta) {
      throw new Error(
        'No se encuentra el ejecutable de Codex. Instálalo con npm install -g @openai/codex, o indica su ruta en la variable de entorno CODEHIVE_CODEX_PATH.',
      );
    }
    return new CodexEngine(ruta);
  }

  /**
   * Codex no informa del coste en dinero ni del consumo de la suscripción, y no tiene una
   * lista de herramientas equivalente a la de Claude Code: lo que limita al agente es el
   * modo de aislamiento. La web solo muestra lo que aquí se declara.
   */
  capabilities(): EngineCapabilities {
    return {
      resumeSession: true,
      resultSchema: true,
      usageReporting: false,
      costReporting: false,
      budgetLimit: false,
      permissionDenials: false,
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

  buildArgs(request: EngineRunRequest, rutaEsquema: string | null, rutaResultado: string): string[] {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      // Sin esta opción, los servidores MCP configurados en el equipo entran en la sesión
      // del agente. En la comprobación de la fase 0, el agente guardó datos en una memoria
      // persistente ajena al proyecto.
      '--ignore-user-config',
      '--output-last-message', rutaResultado,
    ];

    if (necesitaEjecutarOrdenes(request.permissionMode)) {
      // Fuera del sandbox de Codex, que en Windows impide ejecutar cualquier orden.
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('-s', 'read-only', '-c', 'approval_policy="never"');
    }

    if (request.model) args.push('-m', request.model);
    if (rutaEsquema) args.push('--output-schema', rutaEsquema);

    // Las opciones van antes de `resume`, no después: el subcomando no las acepta.
    if (request.resumeSessionId) args.push('resume', request.resumeSessionId);

    // Un guion final indica que el prompt llega por la entrada estándar.
    args.push('-');
    return args;
  }

  start(request: EngineRunRequest, onProgress?: (p: EngineProgress) => void): EngineHandle {
    const temporal = mkdtempSync(join(tmpdir(), 'codehive-codex-'));
    const rutaResultado = join(temporal, 'resultado.txt');
    let rutaEsquema: string | null = null;

    if (request.resultSchema) {
      // Codex recibe el esquema como fichero, no como texto en la línea de órdenes.
      rutaEsquema = join(temporal, 'esquema.json');
      writeFileSync(rutaEsquema, JSON.stringify(request.resultSchema), 'utf8');
    }

    const args = this.buildArgs(request, rutaEsquema, rutaResultado);

    const proceso = spawn(this.executablePath, args, {
      cwd: request.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const estado = new CodexRunState(request, rutaResultado, temporal, onProgress);
    const terminado = estado.attach(proceso, request.timeoutMs);

    return { wait: () => terminado, stop: () => estado.stop() };
  }
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

/** Acumula lo que publica Codex durante una ejecución y arma el resultado final. */
export class CodexRunState {
  private readonly stdout = new LineSplitter();
  private sessionId: string | null = null;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private errorDelMotor: string | null = null;
  private stderr = '';
  private vioFinDeTurno = false;
  private detenidoPorPeticion = false;
  private agotadoPorTiempo = false;
  private proceso: ChildProcess | null = null;

  constructor(
    private readonly request: EngineRunRequest,
    private readonly rutaResultado: string,
    private readonly directorioTemporal: string,
    private readonly onProgress?: (p: EngineProgress) => void,
  ) {}

  attach(proceso: ChildProcess, timeoutMs: number): Promise<EngineRunOutcome> {
    this.proceso = proceso;

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
      this.proceso?.kill('SIGTERM');
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
    this.proceso?.kill('SIGTERM');
  }

  handleLine(linea: string): void {
    let evento: Record<string, unknown>;
    try {
      evento = JSON.parse(linea) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (evento['type']) {
      case 'thread.started':
        if (typeof evento['thread_id'] === 'string') this.sessionId = evento['thread_id'];
        break;

      case 'item.started':
      case 'item.completed':
        this.reportItem(evento['item'], evento['type'] === 'item.completed');
        break;

      case 'turn.completed':
        this.vioFinDeTurno = true;
        this.readUsage(evento['usage']);
        break;

      case 'turn.failed':
        this.vioFinDeTurno = true;
        this.errorDelMotor = this.leerError(evento['error']);
        break;

      case 'error':
        this.errorDelMotor = this.leerError(evento);
        break;

      default:
        break;
    }
  }

  private leerError(valor: unknown): string {
    if (!valor || typeof valor !== 'object') return String(valor ?? 'error sin detalle');
    const v = valor as Record<string, unknown>;
    const mensaje = typeof v['message'] === 'string' ? v['message'] : JSON.stringify(v);

    // Codex a veces mete el error de la API como JSON dentro del texto del mensaje.
    try {
      const anidado = JSON.parse(mensaje) as { error?: { message?: string } };
      if (anidado?.error?.message) return anidado.error.message;
    } catch {
      // El mensaje era texto normal.
    }
    return mensaje;
  }

  private readUsage(usage: unknown): void {
    if (!usage || typeof usage !== 'object') return;
    const u = usage as Record<string, unknown>;
    if (typeof u['input_tokens'] === 'number') this.inputTokens = u['input_tokens'];
    if (typeof u['output_tokens'] === 'number') this.outputTokens = u['output_tokens'];
  }

  private reportItem(item: unknown, completado: boolean): void {
    if (!this.onProgress || !item || typeof item !== 'object') return;
    const i = item as Record<string, unknown>;

    if (i['type'] === 'command_execution') {
      this.onProgress({
        kind: completado ? 'tool_result' : 'tool_use',
        text: String(i['command'] ?? '').slice(0, 500),
        tool: 'Bash',
        isError: i['status'] === 'failed',
      });
      return;
    }

    if (i['type'] === 'mcp_tool_call') {
      this.onProgress({
        kind: completado ? 'tool_result' : 'tool_use',
        text: JSON.stringify(i['arguments'] ?? {}).slice(0, 500),
        tool: `${String(i['server'] ?? 'mcp')}.${String(i['tool'] ?? '')}`,
      });
      return;
    }

    if (completado && typeof i['text'] === 'string') {
      this.onProgress({ kind: 'message', text: i['text'] });
    }
  }

  /** El resultado final lo escribe Codex en el fichero que se le indicó. */
  private leerResultado(): string | null {
    try {
      const texto = readFileSync(this.rutaResultado, 'utf8').trim();
      return texto || null;
    } catch {
      return null;
    }
  }

  private limpiar(): void {
    try {
      rmSync(this.directorioTemporal, { recursive: true, force: true });
    } catch {
      // Si el directorio temporal no se puede borrar, no es motivo para fallar.
    }
  }

  private finalOutcome(code: number | null): EngineRunOutcome {
    if (this.agotadoPorTiempo) {
      return this.outcome('timed_out', `La ejecución superó el tiempo máximo de ${this.request.timeoutMs} ms.`);
    }
    if (this.detenidoPorPeticion) {
      return this.outcome('cancelled', 'La ejecución se detuvo a petición.');
    }
    if (this.errorDelMotor) {
      return this.outcome('failed', this.errorDelMotor);
    }
    if (!this.vioFinDeTurno) {
      return this.outcome(
        'failed',
        `El motor terminó con código ${code} sin completar el turno. ${this.stderr.slice(0, 500)}`.trim(),
      );
    }
    if (code !== 0) {
      return this.outcome('failed', `El motor terminó con código ${code}. ${this.stderr.slice(0, 500)}`.trim());
    }
    return this.outcome('succeeded', null);
  }

  outcome(status: EngineRunOutcome['status'], error: string | null): EngineRunOutcome {
    const resultado = this.leerResultado();
    this.limpiar();

    return {
      status,
      sessionId: this.sessionId,
      resultText: resultado,
      // Codex no informa del coste en dinero ni del consumo de la suscripción.
      costUsd: null,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      permissionDenials: [],
      terminalReason: this.errorDelMotor ? 'api_error' : null,
      usage: null,
      error,
    };
  }
}

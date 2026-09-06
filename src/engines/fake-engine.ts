import type { Engine, EngineHandle, EngineRunOutcome, EngineProgress, EngineRunRequest } from './types.js';

/**
 * Motor que devuelve lo que se le diga sin llamar a ningún modelo.
 *
 * Existe para poder probar todo el sistema sin gastar cuota de la suscripción y sin que
 * el resultado dependa de lo que conteste un modelo.
 */
export class FakeEngine implements Engine {
  readonly name = 'claude_code' as const;
  readonly requests: EngineRunRequest[] = [];

  constructor(
    private respuesta: Partial<EngineRunOutcome> = {},
    private readonly alEjecutar?: (req: EngineRunRequest) => Promise<void>,
  ) {}

  /** Cambia lo que devolverá la siguiente ejecución. */
  setOutcome(respuesta: Partial<EngineRunOutcome>): void {
    this.respuesta = respuesta;
  }

  capabilities() {
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

  async check() {
    return { ok: true, version: 'motor simulado' };
  }

  start(request: EngineRunRequest, onProgress?: (p: EngineProgress) => void): EngineHandle {
    this.requests.push(request);
    let detenido = false;

    const trabajo = (async (): Promise<EngineRunOutcome> => {
      onProgress?.({ kind: 'message', text: 'empiezo' });
      if (this.alEjecutar) await this.alEjecutar(request);
      onProgress?.({ kind: 'message', text: 'termino' });

      if (detenido) {
        return { ...this.base(), status: 'cancelled', error: 'La ejecución se detuvo a petición.' };
      }
      return { ...this.base(), ...this.respuesta };
    })();

    return {
      wait: () => trabajo,
      stop: () => {
        detenido = true;
      },
    };
  }

  private base(): EngineRunOutcome {
    return {
      status: 'succeeded',
      sessionId: 'ses-simulada',
      resultText: null,
      costUsd: 0.01,
      inputTokens: 10,
      outputTokens: 20,
      permissionDenials: [],
      terminalReason: null,
      usage: null,
      error: null,
    };
  }
}

/** Resultado válido del contrato de agente, para usarlo en las pruebas. */
export function resultadoDeAgente(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ outcome: 'completed', summary: 'Trabajo hecho.', ...extra });
}

/** Plan válido del orquestador, para usarlo en las pruebas. */
export function planDeOrquestador(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ reply: 'De acuerdo, me pongo con ello.', ...extra });
}

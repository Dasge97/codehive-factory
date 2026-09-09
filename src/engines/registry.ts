import { ClaudeCodeEngine } from './claude-code.js';
import { CodexEngine } from './codex.js';
import type { Engine } from './types.js';
import type { EngineName } from '../shared/types.js';

/**
 * Motores disponibles, creados una sola vez.
 *
 * Cada agente dice con qué motor se ejecuta, así que el sistema necesita tener los dos a
 * mano y elegir por agente (decisión D34). Un motor que no esté instalado no rompe el
 * arranque: simplemente no está disponible, y los agentes configurados con él quedan
 * bloqueados con un motivo claro.
 */
export class EngineRegistry {
  private readonly motores = new Map<EngineName, Engine>();
  private readonly fallos = new Map<EngineName, string>();

  constructor(motoresIniciales: Engine[] = []) {
    for (const motor of motoresIniciales) this.motores.set(motor.name, motor);
  }

  /** Crea los motores que estén instalados en el equipo. */
  static detect(): EngineRegistry {
    const registro = new EngineRegistry();

    for (const [nombre, crear] of [
      ['claude_code', () => ClaudeCodeEngine.create()],
      ['codex', () => CodexEngine.create()],
    ] as Array<[EngineName, () => Engine]>) {
      try {
        registro.motores.set(nombre, crear());
      } catch (e) {
        registro.fallos.set(nombre, e instanceof Error ? e.message : String(e));
      }
    }

    return registro;
  }

  get(nombre: EngineName): Engine | undefined {
    return this.motores.get(nombre);
  }

  /** Devuelve el motor pedido, o explica por qué no está disponible. */
  require(nombre: EngineName): Engine {
    const motor = this.motores.get(nombre);
    if (motor) return motor;
    throw new Error(this.fallos.get(nombre) ?? `El motor ${nombre} no está configurado.`);
  }

  available(): Engine[] {
    return [...this.motores.values()];
  }

  /** Motores que no se pudieron crear, con el motivo. */
  unavailable(): Array<{ engine: EngineName; reason: string }> {
    return [...this.fallos.entries()].map(([engine, reason]) => ({ engine, reason }));
  }

  /**
   * Comprueba que cada motor disponible responde, con qué versión, y que un encargo mínimo
   * de verdad vuelve con un resultado válido.
   *
   * La versión sola no basta: el 9 de septiembre de 2026 el ejecutable respondía a
   * `--version` y ningún agente podía ejecutarse, porque las opciones habían cambiado. Un
   * motor que no pasa el encargo de prueba se da por no utilizable, con el motivo.
   */
  async check(): Promise<Array<{ engine: EngineName; ok: boolean; version?: string; error?: string; probed: boolean }>> {
    const resultados = [];
    for (const motor of this.motores.values()) {
      const version = await motor.check();
      if (!version.ok || !motor.probe) {
        resultados.push({ engine: motor.name, ...version, probed: false });
        continue;
      }
      const prueba = await motor.probe();
      resultados.push({
        engine: motor.name,
        ok: prueba.ok,
        version: version.version,
        error: prueba.ok ? undefined : `el encargo de prueba falló: ${prueba.error}`,
        probed: true,
      });
    }
    return resultados;
  }
}

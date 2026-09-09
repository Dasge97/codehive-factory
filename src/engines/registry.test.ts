import { describe, it, expect } from 'vitest';
import { EngineRegistry } from './registry.js';
import { FakeEngine } from './fake-engine.js';
import type { Engine } from './types.js';

/**
 * La comprobación de arranque no se fía de que el ejecutable responda a `--version`: lanza
 * un encargo mínimo de verdad y solo da el motor por utilizable si vuelve con un resultado
 * válido (tarea F3-01 del documento 13).
 */

function motorConPrueba(resultado: { ok: boolean; error?: string }): Engine {
  const base = new FakeEngine();
  return Object.assign(base, { probe: async () => resultado }) as Engine;
}

describe('comprobación de arranque de los motores', () => {
  it('un motor cuyo encargo de prueba vuelve bien queda como utilizable', async () => {
    const registro = new EngineRegistry([motorConPrueba({ ok: true })]);
    const [c] = await registro.check();
    expect(c).toMatchObject({ engine: 'claude_code', ok: true, probed: true });
  });

  it('un motor cuyo encargo de prueba falla queda como no utilizable, con el motivo', async () => {
    const registro = new EngineRegistry([motorConPrueba({ ok: false, error: "unknown option '--safe-mode'" })]);
    const [c] = await registro.check();
    expect(c!.ok).toBe(false);
    expect(c!.probed).toBe(true);
    expect(c!.error).toMatch(/encargo de prueba falló.*--safe-mode/);
  });

  it('un motor sin encargo de prueba se acepta solo con la versión', async () => {
    const registro = new EngineRegistry([new FakeEngine()]);
    const [c] = await registro.check();
    expect(c).toMatchObject({ ok: true, probed: false, version: 'motor simulado' });
  });
});

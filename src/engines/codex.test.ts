import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexEngine, CodexRunState } from './codex.js';
import type { EngineProgress, EngineRunRequest } from './types.js';

const motor = new CodexEngine('/ruta/falsa/codex.exe');

const peticionBase: EngineRunRequest = {
  prompt: 'haz algo',
  cwd: '/tmp/wt',
  allowedTools: ['Read', 'Write'],
  timeoutMs: 60_000,
};

describe('argumentos de la línea de órdenes', () => {
  it('lleva las opciones que la comprobación con Codex demostró necesarias', () => {
    const args = motor.buildArgs(peticionBase, null, '/tmp/resultado.txt');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
    // Sin esta opción, los servidores MCP del equipo entran en la sesión del agente.
    expect(args).toContain('--ignore-user-config');
    // El prompt llega por la entrada estándar.
    expect(args[args.length - 1]).toBe('-');
  });

  it('el agente puede ejecutar órdenes en su espacio de trabajo', () => {
    const args = motor.buildArgs({ ...peticionBase, permissionMode: 'bypassPermissions' }, null, '/tmp/r.txt');
    // En Windows, el sandbox propio de Codex rechaza lanzar PowerShell, así que con él
    // activado el agente no puede ni consultar Git ni ejecutar las pruebas.
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('el modo de solo planificar no ejecuta nada', () => {
    const args = motor.buildArgs({ ...peticionBase, permissionMode: 'plan' }, null, '/tmp/r.txt');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args[args.indexOf('-s') + 1]).toBe('read-only');
    expect(args[args.indexOf('-c') + 1]).toBe('approval_policy="never"');
  });

  it('el esquema del resultado va como fichero', () => {
    const args = motor.buildArgs(peticionBase, '/tmp/esquema.json', '/tmp/r.txt');
    expect(args[args.indexOf('--output-schema') + 1]).toBe('/tmp/esquema.json');
  });

  it('continuar una sesión pone las opciones antes del subcomando', () => {
    const args = motor.buildArgs({ ...peticionBase, resumeSessionId: 'hilo-1' }, null, '/tmp/r.txt');
    const posicionResume = args.indexOf('resume');

    expect(posicionResume).toBeGreaterThan(0);
    expect(args[posicionResume + 1]).toBe('hilo-1');
    // El subcomando resume rechaza las opciones que van detrás de él.
    expect(args.indexOf('--json')).toBeLessThan(posicionResume);
    expect(args.indexOf('--ignore-user-config')).toBeLessThan(posicionResume);
  });
});

describe('capacidades declaradas', () => {
  it('dice lo que Codex hace y lo que no', () => {
    const capacidades = motor.capabilities();

    expect(capacidades.resumeSession).toBe(true);
    expect(capacidades.resultSchema).toBe(true);
    expect(capacidades.stop).toBe(true);

    // Codex no informa del coste en dinero ni del consumo de la suscripción.
    expect(capacidades.costReporting).toBe(false);
    expect(capacidades.usageReporting).toBe(false);
    expect(capacidades.budgetLimit).toBe(false);
    expect(capacidades.permissionDenials).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lectura del flujo de eventos, con líneas reales capturadas en la comprobación.
// ---------------------------------------------------------------------------

function leer(lineas: string[], onProgress?: (p: EngineProgress) => void) {
  const temporal = mkdtempSync(join(tmpdir(), 'codex-test-'));
  const estado = new CodexRunState(peticionBase, join(temporal, 'no-existe.txt'), temporal, onProgress);
  for (const l of lineas) estado.handleLine(l);
  return { estado, limpiar: () => rmSync(temporal, { recursive: true, force: true }) };
}

describe('lectura del flujo de Codex', () => {
  it('recoge el identificador del hilo y los tokens', () => {
    const { estado } = leer([
      JSON.stringify({ type: 'thread.started', thread_id: 'hilo-abc' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1000, output_tokens: 50, cached_input_tokens: 800 },
      }),
    ]);

    const r = estado.outcome('succeeded', null);
    expect(r.sessionId).toBe('hilo-abc');
    expect(r.inputTokens).toBe(1000);
    expect(r.outputTokens).toBe(50);
    // Codex no da el coste en dinero.
    expect(r.costUsd).toBeNull();
  });

  it('saca el mensaje de un error de la API aunque venga anidado', () => {
    const { estado } = leer([
      JSON.stringify({
        type: 'turn.failed',
        error: {
          message: JSON.stringify({
            type: 'error',
            status: 400,
            error: { type: 'invalid_request_error', message: 'El modelo no está disponible con esta cuenta.' },
          }),
        },
      }),
    ]);

    const r = estado.outcome('failed', 'fallo');
    expect(r.terminalReason).toBe('api_error');
  });

  it('avisa del progreso con los comandos que ejecuta el agente', () => {
    const pasos: EngineProgress[] = [];
    leer(
      [
        JSON.stringify({
          type: 'item.started',
          item: { id: 'item_1', type: 'command_execution', command: 'npm test', status: 'in_progress' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'item_1', type: 'command_execution', command: 'npm test', status: 'completed' },
        }),
        JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Ya está.' } }),
      ],
      (p) => pasos.push(p),
    );

    expect(pasos.map((p) => p.kind)).toEqual(['tool_use', 'tool_result', 'message']);
    expect(pasos[0]!.text).toBe('npm test');
    expect(pasos[2]!.text).toBe('Ya está.');
  });

  it('marca como error el comando que falló', () => {
    const pasos: EngineProgress[] = [];
    leer(
      [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'command_execution', command: 'npm test', status: 'failed' },
        }),
      ],
      (p) => pasos.push(p),
    );
    expect(pasos[0]!.isError).toBe(true);
  });

  it('ignora una línea que no es JSON sin romperse', () => {
    expect(() => leer(['aviso suelto del motor', JSON.stringify({ type: 'turn.completed' })])).not.toThrow();
  });

  it('sin fin de turno la ejecución no se da por buena', () => {
    const { estado } = leer([JSON.stringify({ type: 'thread.started', thread_id: 'x' })]);
    const r = estado.outcome('failed', 'el motor no completó el turno');
    expect(r.error).toMatch(/no completó el turno/);
  });
});

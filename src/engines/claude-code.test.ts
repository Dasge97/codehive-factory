import { describe, it, expect } from 'vitest';
import { ClaudeCodeEngine, RunState, resolveClaudePath } from './claude-code.js';
import type { EngineProgress, EngineRunRequest } from './types.js';

const motor = new ClaudeCodeEngine('/ruta/falsa/claude.exe');

const peticionBase: EngineRunRequest = {
  prompt: 'haz algo',
  cwd: '/tmp/wt',
  allowedTools: ['Read', 'Write'],
  timeoutMs: 60_000,
};

describe('argumentos de la línea de órdenes', () => {
  it('siempre lleva las opciones que la fase 0 demostró necesarias', () => {
    const args = motor.buildArgs(peticionBase);
    expect(args).toContain('-p');
    expect(args).toContain('--strict-mcp-config');
    expect(args.join(' ')).toContain('--output-format stream-json');
    // Claude Code 2.1 no tiene `--permission-prompts` ni `--safe-mode`: con ellas el motor
    // ni arrancaba. Comprobado el 9 de septiembre de 2026 con la versión 2.1.153.
    expect(args).not.toContain('--permission-prompts');
    expect(args).not.toContain('--safe-mode');
  });

  it('por omisión aísla al agente de la configuración personal del equipo', () => {
    const args = motor.buildArgs(peticionBase);
    expect(args).toContain('--setting-sources');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
  });

  it('con la configuración personal activada no pasa ninguna de las dos opciones', () => {
    const args = motor.buildArgs({ ...peticionBase, usePersonalConfig: true });
    expect(args).not.toContain('--setting-sources');
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('pasa las herramientas separadas por comas', () => {
    const args = motor.buildArgs(peticionBase);
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Write');
  });

  it('sin herramientas pasa una lista vacía', () => {
    const args = motor.buildArgs({ ...peticionBase, allowedTools: [] });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
  });

  it('continúa una sesión anterior en lugar de abrir una nueva', () => {
    const args = motor.buildArgs({ ...peticionBase, sessionId: 'nueva', resumeSessionId: 'anterior' });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('anterior');
    expect(args).not.toContain('--session-id');
  });

  it('abre sesión nueva cuando no hay ninguna que continuar', () => {
    const args = motor.buildArgs({ ...peticionBase, sessionId: 'nueva' });
    expect(args[args.indexOf('--session-id') + 1]).toBe('nueva');
  });

  it('incluye el esquema del resultado', () => {
    const args = motor.buildArgs({ ...peticionBase, resultSchema: { type: 'object' } });
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
  });
});

describe('capacidades declaradas', () => {
  it('coinciden con lo comprobado en la fase 0', () => {
    expect(motor.capabilities()).toEqual({
      resumeSession: true,
      resultSchema: true,
      usageReporting: true,
      costReporting: true,
      budgetLimit: true,
      permissionDenials: true,
      stop: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Lectura del flujo de eventos, con líneas reales capturadas en la fase 0.
// ---------------------------------------------------------------------------

function leer(lineas: string[], onProgress?: (p: EngineProgress) => void) {
  const estado = new RunState(peticionBase, onProgress);
  for (const l of lineas) estado.handleLine(l);
  return estado;
}

const LINEA_INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ses-1', model: 'sonnet' });

const LINEA_LIMITES = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.03, resetsAt: 1788702600 },
      seven_day: { utilization: 0.04, resetsAt: 1789171200 },
    },
  },
});

const LINEA_RESULTADO = JSON.stringify({
  type: 'result',
  session_id: 'ses-1',
  result: '{"outcome":"completed","summary":"hecho"}',
  total_cost_usd: 0.0234,
  usage: { input_tokens: 12, output_tokens: 34 },
  permission_denials: [],
});

describe('lectura del flujo del motor', () => {
  it('recoge el identificador de sesión, el coste y los tokens', () => {
    const r = leer([LINEA_INIT, LINEA_LIMITES, LINEA_RESULTADO]).outcome('succeeded', null);
    expect(r.sessionId).toBe('ses-1');
    expect(r.costUsd).toBeCloseTo(0.0234);
    expect(r.inputTokens).toBe(12);
    expect(r.outputTokens).toBe(34);
    expect(r.resultText).toBe('{"outcome":"completed","summary":"hecho"}');
  });

  it('con Claude Code 2.1 el resultado estructurado viene en su propio campo, no en el texto', () => {
    // Capturado el 9 de septiembre de 2026 con la versión 2.1.153: `result` lleva la frase
    // de despedida del agente y `structured_output` el objeto que cumple el esquema.
    const linea = JSON.stringify({
      type: 'result',
      result: '¡Listo! He incluido el resultado en el campo pedido.',
      structured_output: { outcome: 'completed', summary: 'hecho' },
    });
    const r = leer([linea]).outcome('succeeded', null);
    expect(JSON.parse(r.resultText!)).toEqual({ outcome: 'completed', summary: 'hecho' });
  });

  it('recoge el consumo de la suscripción', () => {
    const r = leer([LINEA_LIMITES]).outcome('succeeded', null);
    expect(r.usage?.status).toBe('allowed');
    expect(r.usage?.fiveHourUtilization).toBeCloseTo(0.03);
    expect(r.usage?.sevenDayUtilization).toBeCloseTo(0.04);
    expect(r.usage?.usingOverage).toBe(false);
    expect(r.usage?.fiveHourResetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('recoge las acciones denegadas por falta de permiso', () => {
    const linea = JSON.stringify({
      type: 'result',
      result: 'ok',
      permission_denials: [{ tool_name: 'Write', tool_input: { file_path: 'b.txt', content: 'hola' } }],
    });
    const r = leer([linea]).outcome('succeeded', null);
    expect(r.permissionDenials).toHaveLength(1);
    expect(r.permissionDenials[0]!.tool_name).toBe('Write');
    expect(r.permissionDenials[0]!.tool_input).toEqual({ file_path: 'b.txt', content: 'hola' });
  });

  it('avisa del progreso con los mensajes y las herramientas del agente', () => {
    const pasos: EngineProgress[] = [];
    leer(
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Voy a leer el fichero' },
              { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', content: 'contenido', is_error: false }] },
        }),
      ],
      (p) => pasos.push(p),
    );

    expect(pasos.map((p) => p.kind)).toEqual(['message', 'tool_use', 'tool_result']);
    expect(pasos[1]!.tool).toBe('Read');
  });

  it('ignora una línea que no es JSON sin romperse', () => {
    expect(() => leer(['Warning: algo', LINEA_RESULTADO])).not.toThrow();
  });
});

describe('estado final de la ejecución', () => {
  it('un fallo de la API se distingue de un error normal', () => {
    const linea = JSON.stringify({ type: 'result', result: '', terminal_reason: 'api_error' });
    const estado = leer([linea]);
    const r = estado.outcome('failed', 'El motor no pudo hablar con la API: credenciales, cuota o red.');
    expect(r.terminalReason).toBe('api_error');
    expect(r.error).toMatch(/credenciales/);
  });
});

describe('localización del ejecutable', () => {
  it('la variable de entorno tiene prioridad cuando el fichero existe', () => {
    const original = process.env['CODEHIVE_CLAUDE_PATH'];
    process.env['CODEHIVE_CLAUDE_PATH'] = '/no/existe/claude';
    // Al no existir el fichero, no se usa la variable y se cae a la búsqueda normal.
    expect(resolveClaudePath()).not.toBe('/no/existe/claude');
    if (original === undefined) delete process.env['CODEHIVE_CLAUDE_PATH'];
    else process.env['CODEHIVE_CLAUDE_PATH'] = original;
  });
});

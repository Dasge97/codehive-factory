import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { createProject } from './projects.js';
import { guardarTurno, listarTurnos, resumenDeTurnos } from './orchestrator-turns.js';
import type { Project } from '../shared/types.js';

/**
 * Cada mensaje del creador lanza una ejecución del motor con el estado del proyecto
 * entero. Sin guardar esos turnos, la pregunta de cuánto cuesta hablar con el orquestador
 * solo se puede responder con una estimación.
 */

let db: Db;
let proyecto: Project;

beforeEach(() => {
  db = openDatabase(':memory:');
  proyecto = createProject(db, { name: 'Prueba', repo_path: '/tmp/prueba' });
});

function turno(chars: number, entrada: number | null, salida: number | null, coste: number | null) {
  return guardarTurno(db, {
    project_id: proyecto.id,
    engine: 'claude_code',
    model: 'opus',
    status: 'succeeded',
    prompt_chars: chars,
    input_tokens: entrada,
    output_tokens: salida,
    cost_usd: coste,
    error: null,
    started_at: new Date().toISOString(),
  });
}

describe('turnos del orquestador', () => {
  it('sin turnos, el resumen lo dice en vez de inventar medias', () => {
    const resumen = resumenDeTurnos(db, proyecto.id);
    expect(resumen.turnos).toBe(0);
    expect(resumen.encargo_medio).toBeNull();
    expect(resumen.ultimo_encargo).toBeNull();
  });

  it('guarda el tamaño del encargo y lo que informó el motor', () => {
    const guardado = turno(17158, 4700, 900, 0.21);

    expect(guardado.prompt_chars).toBe(17158);
    expect(guardado.input_tokens).toBe(4700);
    expect(listarTurnos(db, proyecto.id)).toHaveLength(1);
  });

  it('el resumen saca las medias y el coste total', () => {
    turno(10000, 3000, 500, 0.1);
    turno(20000, 5000, 700, 0.3);

    const resumen = resumenDeTurnos(db, proyecto.id);
    expect(resumen.turnos).toBe(2);
    expect(resumen.encargo_medio).toBe(15000);
    expect(resumen.entrada_media).toBe(4000);
    expect(resumen.salida_media).toBe(600);
    expect(resumen.coste_total).toBeCloseTo(0.4, 5);
  });

  it('el último encargo es el del turno más reciente', () => {
    turno(10000, 3000, 500, 0.1);
    turno(29548, 8200, 700, 0.3);

    expect(resumenDeTurnos(db, proyecto.id).ultimo_encargo).toBe(29548);
  });

  it('un motor que no informa de tokens deja el tamaño del encargo igualmente', () => {
    // Codex no informa de su consumo. Contar los caracteres no depende del motor.
    guardarTurno(db, {
      project_id: proyecto.id,
      engine: 'codex',
      model: null,
      status: 'succeeded',
      prompt_chars: 12000,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      error: null,
      started_at: new Date().toISOString(),
    });

    const resumen = resumenDeTurnos(db, proyecto.id);
    expect(resumen.encargo_medio).toBe(12000);
    expect(resumen.entrada_media).toBeNull();
  });

  it('un turno que falló también se guarda, con su motivo', () => {
    guardarTurno(db, {
      project_id: proyecto.id,
      engine: 'claude_code',
      model: 'opus',
      status: 'failed',
      prompt_chars: 8000,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      error: 'el motor no devolvió nada',
      started_at: new Date().toISOString(),
    });

    const guardados = listarTurnos(db, proyecto.id);
    expect(guardados[0]!.status).toBe('failed');
    expect(guardados[0]!.error).toBe('el motor no devolvió nada');
  });
});

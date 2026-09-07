import type { Db } from './db.js';
import { newId, now } from '../shared/ids.js';

/**
 * Lo que cuesta hablar con el orquestador.
 *
 * Cada mensaje del creador lanza una ejecución del motor. El orquestador no continúa
 * ninguna sesión: en cada turno se le manda el estado del proyecto entero, así que el
 * tamaño del encargo crece con el número de tareas.
 *
 * Se guarda para poder responder con datos a la pregunta de cuánto cuesta, en vez de con
 * una estimación. El tamaño en caracteres se mide aquí y no depende de lo que informe el
 * motor, que con algunos no informa nada.
 */

export interface TurnoDelOrquestador {
  id: string;
  project_id: string;
  engine: string;
  model: string | null;
  status: string;
  prompt_chars: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
  started_at: string;
  ended_at: string;
}

export interface GuardarTurnoInput {
  project_id: string;
  engine: string;
  model: string | null;
  status: string;
  prompt_chars: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
  started_at: string;
}

export function guardarTurno(db: Db, input: GuardarTurnoInput): TurnoDelOrquestador {
  const id = newId('orchestratorTurn');
  db.prepare(
    `INSERT INTO orchestrator_turns (
       id, project_id, engine, model, status, prompt_chars,
       input_tokens, output_tokens, cost_usd, error, started_at, ended_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.project_id,
    input.engine,
    input.model,
    input.status,
    input.prompt_chars,
    input.input_tokens,
    input.output_tokens,
    input.cost_usd,
    input.error,
    input.started_at,
    now(),
  );

  return db.prepare('SELECT * FROM orchestrator_turns WHERE id = ?').get(id) as TurnoDelOrquestador;
}

/** Los últimos turnos, del más reciente al más antiguo. */
export function listarTurnos(db: Db, projectId: string, limite = 50): TurnoDelOrquestador[] {
  return db
    .prepare(
      'SELECT * FROM orchestrator_turns WHERE project_id = ? ORDER BY started_at DESC LIMIT ?',
    )
    .all(projectId, limite) as TurnoDelOrquestador[];
}

export interface ResumenDeTurnos {
  turnos: number;
  /** Tamaño del encargo del último turno, en caracteres. */
  ultimo_encargo: number | null;
  encargo_medio: number | null;
  entrada_media: number | null;
  salida_media: number | null;
  coste_total: number | null;
}

/**
 * Cuánto ha costado hablar con el orquestador en este proyecto.
 *
 * Los tokens y el coste solo salen de los motores que los informan. Codex no lo hace, así
 * que ahí solo se puede contar el tamaño del encargo.
 */
export function resumenDeTurnos(db: Db, projectId: string): ResumenDeTurnos {
  const fila = db
    .prepare(
      `SELECT COUNT(*) AS turnos,
              AVG(prompt_chars) AS encargo_medio,
              AVG(input_tokens) AS entrada_media,
              AVG(output_tokens) AS salida_media,
              SUM(cost_usd) AS coste_total
       FROM orchestrator_turns WHERE project_id = ?`,
    )
    .get(projectId) as {
    turnos: number;
    encargo_medio: number | null;
    entrada_media: number | null;
    salida_media: number | null;
    coste_total: number | null;
  };

  const ultimo = db
    .prepare(
      'SELECT prompt_chars FROM orchestrator_turns WHERE project_id = ? ORDER BY started_at DESC LIMIT 1',
    )
    .get(projectId) as { prompt_chars: number } | undefined;

  const redondear = (n: number | null) => (n === null ? null : Math.round(n));

  return {
    turnos: fila.turnos,
    ultimo_encargo: ultimo?.prompt_chars ?? null,
    encargo_medio: redondear(fila.encargo_medio),
    entrada_media: redondear(fila.entrada_media),
    salida_media: redondear(fila.salida_media),
    coste_total: fila.coste_total,
  };
}

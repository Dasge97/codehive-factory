import { EventEmitter } from 'node:events';
import type { Db } from './db.js';
import { now } from '../shared/ids.js';
import type { NewEvent, SystemEvent } from '../shared/types.js';

/**
 * Canal por el que se avisa de cada evento recién guardado. La web se suscribe a él para
 * enviar actualizaciones en vivo. Los suscriptores reciben el evento ya guardado, con su
 * identificador, para poder reanudar desde ahí tras una desconexión.
 */
export class EventBus extends EventEmitter {
  emitEvent(event: SystemEvent): void {
    this.emit('event', event);
    this.emit(`project:${event.project_id}`, event);
  }

  onEvent(listener: (event: SystemEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  onProject(projectId: string, listener: (event: SystemEvent) => void): () => void {
    const canal = `project:${projectId}`;
    this.on(canal, listener);
    return () => this.off(canal, listener);
  }
}

/**
 * Guarda un evento y avisa a los suscriptores. Los eventos son inmutables: una
 * corrección se publica como un evento nuevo, nunca modificando uno existente.
 *
 * Se llama dentro de la misma transacción que el cambio de estado que describe, para que
 * no pueda quedar un cambio sin su evento. El aviso a los suscriptores se hace después de
 * que la transacción termine, cosa que garantiza `appendEvents`.
 */
export function insertEvent(db: Db, event: NewEvent): SystemEvent {
  const creado = now();
  const info = db
    .prepare(
      `INSERT INTO events (project_id, type, task_id, run_id, agent_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.project_id,
      event.type,
      event.task_id ?? null,
      event.run_id ?? null,
      event.agent_id ?? null,
      JSON.stringify(event.payload),
      creado,
    );

  return {
    id: Number(info.lastInsertRowid),
    project_id: event.project_id,
    type: event.type,
    task_id: event.task_id ?? null,
    run_id: event.run_id ?? null,
    agent_id: event.agent_id ?? null,
    payload: JSON.stringify(event.payload),
    created_at: creado,
  };
}

/** Guarda un evento y lo publica. Úsese fuera de una transacción. */
export function appendEvent(db: Db, bus: EventBus, event: NewEvent): SystemEvent {
  const guardado = insertEvent(db, event);
  bus.emitEvent(guardado);
  return guardado;
}

/** Publica varios eventos ya guardados. Se llama justo después de cerrar la transacción. */
export function publishEvents(bus: EventBus, events: SystemEvent[]): void {
  for (const event of events) bus.emitEvent(event);
}

/**
 * Devuelve los eventos de un proyecto posteriores a un identificador dado. Es lo que
 * permite a la web recuperar lo que se perdió mientras estuvo desconectada.
 */
export function listEvents(
  db: Db,
  projectId: string,
  opciones: { sinceId?: number; limit?: number } = {},
): SystemEvent[] {
  const { sinceId = 0, limit = 200 } = opciones;
  return db
    .prepare(
      `SELECT * FROM events
       WHERE project_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(projectId, sinceId, limit) as SystemEvent[];
}

/** Devuelve los últimos eventos de un proyecto, del más reciente al más antiguo. */
export function listRecentEvents(db: Db, projectId: string, limit = 50): SystemEvent[] {
  return db
    .prepare('SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .all(projectId, limit) as SystemEvent[];
}

/** Convierte la carga de un evento guardado en un objeto. */
export function eventPayload<T = Record<string, unknown>>(event: SystemEvent): T {
  return JSON.parse(event.payload) as T;
}

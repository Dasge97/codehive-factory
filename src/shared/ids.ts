import { randomBytes } from 'node:crypto';

/**
 * Prefijos de identificador. El prefijo hace legible cualquier registro o mensaje de
 * error sin tener que consultar de qué tabla viene el identificador.
 */
export const ID_PREFIX = {
  project: 'prj',
  agent: 'agt',
  task: 'tsk',
  run: 'run',
  increment: 'inc',
  finding: 'fnd',
  decision: 'dec',
  chatMessage: 'msg',
  approval: 'apr',
  lock: 'lck',
  worker: 'wkr',
  agentMessage: 'amsg',
  notice: 'ntc',
} as const;

/** Nombre del tipo de entidad, por ejemplo 'task'. */
export type EntityKind = keyof typeof ID_PREFIX;
/** Prefijo que lleva el identificador, por ejemplo 'tsk'. */
export type IdPrefix = (typeof ID_PREFIX)[EntityKind];

/**
 * Genera un identificador ordenable por tiempo: prefijo, marca de tiempo en base 36 y
 * ocho caracteres aleatorios. Ordenar por identificador ordena por antigüedad, lo que
 * evita tener que unir con la fecha de creación para listados sencillos.
 */
export function newId(kind: EntityKind): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const random = randomBytes(5).toString('hex').slice(0, 8);
  return `${ID_PREFIX[kind]}_${time}${random}`;
}

/** Marca de tiempo en formato ISO 8601 con zona horaria, como se guarda en la base de datos. */
export function now(): string {
  return new Date().toISOString();
}

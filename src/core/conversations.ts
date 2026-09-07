import type { Db } from './db.js';
import { newId, now } from '../shared/ids.js';

/**
 * Conversaciones con el orquestador.
 *
 * Un proyecto tiene varias a lo largo del tiempo y solo una abierta. El orquestador
 * únicamente ve la abierta, que es lo que hace que empezar una nueva sirva de algo: si
 * viera todas, el encargo crecería sin fin y arrastraría lo hablado hace semanas.
 *
 * Una conversación no se cierra sola. Empieza cuando la persona lo pide, y las anteriores
 * quedan guardadas para poder volver a ellas.
 *
 * Nada de esto es una sesión de Claude. El orquestador no continúa ninguna sesión: en cada
 * turno recibe el estado del proyecto y la conversación abierta.
 */

export interface Conversation {
  id: string;
  project_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

/** Una conversación con lo que hace falta para elegirla en una lista. */
export interface ConversationView extends Conversation {
  messages: number;
  last_message_at: string | null;
  is_current: number;
}

/** Cuánto del primer mensaje se guarda como título de la conversación. */
const LARGO_DEL_TITULO = 60;

/**
 * La conversación abierta del proyecto, creando una si todavía no hay ninguna.
 *
 * Un proyecto sin conversación abierta no puede pasar en la práctica, porque la migración
 * le pone una. Se crea aquí de todas formas para que un proyecto recién registrado no
 * dependa de que alguien la haya creado antes.
 */
export function conversacionActual(db: Db, projectId: string): Conversation {
  const proyecto = db
    .prepare('SELECT current_conversation_id FROM projects WHERE id = ?')
    .get(projectId) as { current_conversation_id: string | null } | undefined;

  if (!proyecto) throw new Error(`El proyecto ${projectId} no existe.`);

  if (proyecto.current_conversation_id) {
    const abierta = db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(proyecto.current_conversation_id) as Conversation | undefined;
    if (abierta) return abierta;
  }

  return nuevaConversacion(db, projectId);
}

/** Empieza una conversación en blanco y la deja abierta. */
export function nuevaConversacion(db: Db, projectId: string): Conversation {
  const id = newId('conversation');
  const momento = now();

  db.prepare(
    'INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
  ).run(id, projectId, momento, momento);

  db.prepare('UPDATE projects SET current_conversation_id = ?, updated_at = ? WHERE id = ?').run(
    id,
    momento,
    projectId,
  );

  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation;
}

/** Vuelve a una conversación anterior del mismo proyecto. */
export function abrirConversacion(db: Db, projectId: string, conversationId: string): Conversation {
  const conversacion = db
    .prepare('SELECT * FROM conversations WHERE id = ? AND project_id = ?')
    .get(conversationId, projectId) as Conversation | undefined;

  if (!conversacion) {
    throw new Error(`La conversación ${conversationId} no es de este proyecto.`);
  }

  db.prepare('UPDATE projects SET current_conversation_id = ?, updated_at = ? WHERE id = ?').run(
    conversationId,
    now(),
    projectId,
  );

  return conversacion;
}

/**
 * Las conversaciones del proyecto, de la más reciente a la más antigua.
 *
 * Cada una trae cuántos mensajes tiene y cuándo fue el último, que es lo que permite
 * reconocerla en la lista sin abrirla.
 */
export function listarConversaciones(db: Db, projectId: string): ConversationView[] {
  return db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS messages,
              (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.conversation_id = c.id) AS last_message_at,
              (c.id = (SELECT current_conversation_id FROM projects p WHERE p.id = c.project_id)) AS is_current
       FROM conversations c
       WHERE c.project_id = ?
       ORDER BY c.created_at DESC`,
    )
    .all(projectId) as ConversationView[];
}

/**
 * Pone título a una conversación con el primer mensaje de la persona.
 *
 * Solo la primera vez. Una conversación con título ya se reconoce en la lista, y
 * cambiárselo con cada mensaje haría imposible encontrarla.
 */
export function ponerTituloSiFalta(db: Db, conversationId: string, texto: string): void {
  const actual = db
    .prepare('SELECT title FROM conversations WHERE id = ?')
    .get(conversationId) as { title: string | null } | undefined;

  if (!actual || actual.title) return;

  const limpio = texto.replace(/\s+/g, ' ').trim();
  if (!limpio) return;

  const corte = limpio.lastIndexOf(' ', LARGO_DEL_TITULO);
  const titulo =
    limpio.length <= LARGO_DEL_TITULO
      ? limpio
      : `${limpio.slice(0, corte > LARGO_DEL_TITULO * 0.6 ? corte : LARGO_DEL_TITULO)}…`;

  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(
    titulo,
    now(),
    conversationId,
  );
}

/** Marca que en esta conversación ha pasado algo, para poder ordenarlas por uso. */
export function tocarConversacion(db: Db, conversationId: string): void {
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), conversationId);
}

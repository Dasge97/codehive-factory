import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { EventBus } from './events.js';
import { createAgent, createProject } from './projects.js';
import {
  abrirConversacion,
  conversacionActual,
  listarConversaciones,
  nuevaConversacion,
} from './conversations.js';
import {
  listChat,
  listChatDeConversacion,
  postChatMessage,
  projectSnapshot,
} from './orchestrator.js';
import type { Project } from '../shared/types.js';

/**
 * Conversaciones con el orquestador.
 *
 * Un proyecto tiene varias y solo una abierta. El orquestador solo ve la abierta: es lo
 * que hace que empezar una nueva sirva de algo, en vez de arrastrar para siempre todo lo
 * hablado desde el principio.
 */

let db: Db;
let bus: EventBus;
let proyecto: Project;

beforeEach(() => {
  db = openDatabase(':memory:');
  bus = new EventBus();
  proyecto = createProject(db, { name: 'Prueba', repo_path: '/tmp/prueba' });
  createAgent(db, {
    project_id: proyecto.id,
    name: 'Orquestador',
    role: 'orchestrator',
    engine: 'claude_code',
    instructions: 'x',
    allowed_tools: ['Read'],
  });
});

describe('una conversación abierta por proyecto', () => {
  it('un proyecto recién creado ya tiene una', () => {
    expect(conversacionActual(db, proyecto.id).project_id).toBe(proyecto.id);
  });

  it('los mensajes van a la conversación abierta', () => {
    postChatMessage(db, bus, proyecto.id, 'creator', 'Añade la validación de nombres');

    const actual = conversacionActual(db, proyecto.id);
    expect(listChatDeConversacion(db, actual.id)).toHaveLength(1);
  });

  it('el título sale del primer mensaje de la persona', () => {
    postChatMessage(db, bus, proyecto.id, 'creator', 'Añade la validación de nombres');
    expect(conversacionActual(db, proyecto.id).title).toBe('Añade la validación de nombres');
  });

  it('el título no cambia con los mensajes siguientes', () => {
    postChatMessage(db, bus, proyecto.id, 'creator', 'Añade la validación de nombres');
    postChatMessage(db, bus, proyecto.id, 'orchestrator', 'De acuerdo.');
    postChatMessage(db, bus, proyecto.id, 'creator', 'Y ahora otra cosa distinta');

    expect(conversacionActual(db, proyecto.id).title).toBe('Añade la validación de nombres');
  });

  it('un primer mensaje larguísimo se recorta para el título', () => {
    postChatMessage(db, bus, proyecto.id, 'creator', 'Una petición muy larga. '.repeat(20));

    const titulo = conversacionActual(db, proyecto.id).title!;
    expect(titulo.length).toBeLessThan(70);
    expect(titulo.endsWith('…')).toBe(true);
  });

  it('lo que dice el orquestador no pone título', () => {
    postChatMessage(db, bus, proyecto.id, 'orchestrator', 'Te aviso de que he terminado.');
    expect(conversacionActual(db, proyecto.id).title).toBeNull();
  });
});

describe('empezar una conversación nueva', () => {
  it('el chat queda en blanco y lo anterior no se borra', () => {
    postChatMessage(db, bus, proyecto.id, 'creator', 'Lo de antes');
    const primera = conversacionActual(db, proyecto.id);

    nuevaConversacion(db, proyecto.id);

    expect(listChat(db, proyecto.id)).toHaveLength(0);
    expect(listChatDeConversacion(db, primera.id)).toHaveLength(1);
  });

  it('el orquestador deja de ver lo hablado antes', () => {
    postChatMessage(db, bus, proyecto.id, 'creator', 'Un asunto ya cerrado');
    nuevaConversacion(db, proyecto.id);
    postChatMessage(db, bus, proyecto.id, 'creator', 'Un asunto nuevo');

    const chat = projectSnapshot(db, proyecto.id).chat.map((m) => m.body);
    expect(chat).toEqual(['Un asunto nuevo']);
  });

  it('la lista las trae todas, con la abierta marcada', () => {
    postChatMessage(db, bus, proyecto.id, 'creator', 'Primera');
    const segunda = nuevaConversacion(db, proyecto.id);
    postChatMessage(db, bus, proyecto.id, 'creator', 'Segunda');

    const lista = listarConversaciones(db, proyecto.id);
    expect(lista).toHaveLength(2);
    expect(lista[0]!.id).toBe(segunda.id);
    expect(lista[0]!.is_current).toBe(1);
    expect(lista[1]!.is_current).toBe(0);
    expect(lista[1]!.messages).toBe(1);
  });
});

describe('volver a una conversación anterior', () => {
  it('se recupera con todo lo que se dijo', () => {
    postChatMessage(db, bus, proyecto.id, 'creator', 'Lo de antes');
    postChatMessage(db, bus, proyecto.id, 'orchestrator', 'De acuerdo.');
    const primera = conversacionActual(db, proyecto.id);

    nuevaConversacion(db, proyecto.id);
    postChatMessage(db, bus, proyecto.id, 'creator', 'Otra cosa');

    abrirConversacion(db, proyecto.id, primera.id);

    expect(listChat(db, proyecto.id).map((m) => m.body)).toEqual(['Lo de antes', 'De acuerdo.']);
  });

  it('y al escribir, el mensaje entra en la que se ha vuelto a abrir', () => {
    postChatMessage(db, bus, proyecto.id, 'creator', 'Lo de antes');
    const primera = conversacionActual(db, proyecto.id);

    nuevaConversacion(db, proyecto.id);
    abrirConversacion(db, proyecto.id, primera.id);
    postChatMessage(db, bus, proyecto.id, 'creator', 'Sigo con esto');

    expect(listChatDeConversacion(db, primera.id)).toHaveLength(2);
  });

  it('no se puede abrir una conversación de otro proyecto', () => {
    const otro = createProject(db, { name: 'Otro', repo_path: '/tmp/otro' });
    const ajena = conversacionActual(db, otro.id);

    expect(() => abrirConversacion(db, proyecto.id, ajena.id)).toThrow(/no es de este proyecto/);
  });
});

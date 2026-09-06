import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { EventBus } from './events.js';
import { createAgent, createProject } from './projects.js';
import { createTask, requireTask } from './tasks.js';
import { claimTask } from './queue.js';
import {
  MAX_MENSAJES_POR_CONVERSACION,
  helpRequestToTask,
  markDelivered,
  pendingForAgent,
  renderTeamDirectory,
  sendAgentMessage,
  teamDirectory,
  threadMessages,
} from './agent-messages.js';
import type { Agent, Project, Task } from '../shared/types.js';

let db: Db;
let bus: EventBus;
let proyecto: Project;
let builder: Agent;
let investigador: Agent;
let orquestador: Agent;

beforeEach(() => {
  db = openDatabase(':memory:');
  bus = new EventBus();
  proyecto = createProject(db, { name: 'Prueba', repo_path: '/tmp/prueba' });

  orquestador = createAgent(db, {
    project_id: proyecto.id, name: 'Orquestador', role: 'orchestrator', engine: 'claude_code',
    instructions: 'coordina', allowed_tools: ['Read'],
  });
  builder = createAgent(db, {
    project_id: proyecto.id, name: 'Builder', role: 'builder', engine: 'claude_code',
    instructions: 'construye', allowed_tools: ['Read', 'Write'],
  });
  investigador = createAgent(db, {
    project_id: proyecto.id, name: 'Investigador', role: 'researcher', engine: 'claude_code',
    instructions: 'investiga', allowed_tools: ['Read'],
  });
});

function nuevaTarea(): Task {
  return createTask(db, bus, {
    project_id: proyecto.id, kind: 'build', title: 'Añadir el área de proyectos',
    goal: 'Objetivo', required_role: 'builder', created_by: 'creator', priority: 50,
  });
}

describe('P2-04 · un agente pide ayuda a otro', () => {
  it('la petición de apoyo crea una tarea con responsable', () => {
    const original = nuevaTarea();

    const apoyo = helpRequestToTask(db, bus, {
      project_id: proyecto.id,
      from_agent_id: builder.id,
      to_role: 'researcher',
      body: '¿Cómo se validan los nombres en el resto del proyecto?',
      task_id: original.id,
    });

    expect(apoyo.kind).toBe('research');
    expect(apoyo.required_role).toBe('researcher');
    expect(apoyo.parent_task_id).toBe(original.id);
    expect(apoyo.goal).toMatch(/validan los nombres/);
    // Entra por delante de la tarea que la pidió.
    expect(apoyo.priority).toBeLessThan(original.priority);
  });

  it('el hilo completo queda registrado y se puede seguir', () => {
    const original = nuevaTarea();

    const pregunta = sendAgentMessage(db, bus, {
      project_id: proyecto.id, from_agent_id: builder.id, to_agent_id: investigador.id,
      kind: 'question', body: '¿Dónde está la validación?', task_id: original.id,
    });

    sendAgentMessage(db, bus, {
      project_id: proyecto.id, from_agent_id: investigador.id, to_agent_id: builder.id,
      kind: 'answer', body: 'En src/validate.ts, línea 12.', task_id: original.id,
      thread_id: pregunta.message.thread_id,
    });

    const hilo = threadMessages(db, pregunta.message.thread_id);
    expect(hilo).toHaveLength(2);
    expect(hilo[0]!.kind).toBe('question');
    expect(hilo[1]!.kind).toBe('answer');
    expect(hilo[1]!.body).toMatch(/src\/validate.ts/);
  });

  it('un agente recibe sus mensajes pendientes una sola vez', () => {
    sendAgentMessage(db, bus, {
      project_id: proyecto.id, from_agent_id: builder.id, to_agent_id: investigador.id,
      kind: 'question', body: 'una pregunta',
    });

    expect(pendingForAgent(db, investigador.id)).toHaveLength(1);
    markDelivered(db, investigador.id);
    expect(pendingForAgent(db, investigador.id)).toHaveLength(0);
  });

  it('un aviso sin destinatario llega a todo el equipo', () => {
    sendAgentMessage(db, bus, {
      project_id: proyecto.id, from_agent_id: investigador.id,
      kind: 'notice', body: 'La base de datos no admite nombres largos.',
    });

    expect(pendingForAgent(db, builder.id)).toHaveLength(1);
    expect(pendingForAgent(db, orquestador.id)).toHaveLength(1);
  });
});

describe('P2-05 · una conversación no entra en bucle', () => {
  it('al llegar al límite el asunto se escala al orquestador', () => {
    const primero = sendAgentMessage(db, bus, {
      project_id: proyecto.id, from_agent_id: builder.id, to_agent_id: investigador.id,
      kind: 'question', body: 'mensaje 1',
    });
    const hilo = primero.message.thread_id;

    // Se llena la conversación hasta el límite.
    for (let i = 2; i <= MAX_MENSAJES_POR_CONVERSACION; i++) {
      const r = sendAgentMessage(db, bus, {
        project_id: proyecto.id, from_agent_id: builder.id, to_agent_id: investigador.id,
        kind: 'question', body: `mensaje ${i}`, thread_id: hilo,
      });
      expect(r.escalated).toBe(false);
    }

    // El siguiente ya no es una pregunta más: se escala.
    const pasado = sendAgentMessage(db, bus, {
      project_id: proyecto.id, from_agent_id: builder.id, to_agent_id: investigador.id,
      kind: 'question', body: 'seguimos sin ponernos de acuerdo', thread_id: hilo,
    });

    expect(pasado.escalated).toBe(true);
    expect(pasado.message.kind).toBe('escalation');
    expect(pasado.message.to_agent_id).toBe(orquestador.id);
    expect(pasado.message.body).toMatch(/sin conclusión/);
  });
});

describe('directorio del equipo', () => {
  it('dice quién está libre y con qué está', () => {
    const t = nuevaTarea();
    claimTask(db, bus, {
      task_id: t.id, agent_id: builder.id, worker_id: 'w1', engine: 'claude_code',
    });

    const equipo = teamDirectory(db, proyecto.id);
    const constructor = equipo.find((a) => a.role === 'builder')!;
    const buscador = equipo.find((a) => a.role === 'researcher')!;

    expect(constructor.available).toBe(false);
    expect(constructor.busy_workers).toBe(1);
    expect(constructor.current_tasks[0]!.title).toBe(requireTask(db, t.id).title);

    expect(buscador.available).toBe(true);
    expect(buscador.busy_workers).toBe(0);
  });

  it('se escribe en frases que un agente puede leer', () => {
    const texto = renderTeamDirectory(teamDirectory(db, proyecto.id));
    expect(texto).toContain('Builder (builder, claude_code): disponible');
    expect(texto).toContain('tareas en su cola');
  });
});

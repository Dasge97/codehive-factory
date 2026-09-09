import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { EventBus } from './events.js';
import { createAgent, createProject } from './projects.js';
import { createTask, pendingNotices, requireTask, setStatus } from './tasks.js';
import { sendAgentMessage } from './agent-messages.js';
import { applyPlan, projectSnapshot, renderOrchestratorPrompt } from './orchestrator.js';
import type { Agent, Project, Task } from '../shared/types.js';

/**
 * Las preguntas de los agentes llegan al orquestador, y el orquestador puede contestarlas
 * con una nota a la tarea y reabrir lo que estaba bloqueado (decisión D46).
 */

let db: Db;
let bus: EventBus;
let proyecto: Project;
let orquestador: Agent;
let builder: Agent;

beforeEach(() => {
  db = openDatabase(':memory:');
  bus = new EventBus();
  proyecto = createProject(db, { name: 'Prueba', repo_path: '/tmp/prueba' });
  orquestador = createAgent(db, {
    project_id: proyecto.id, name: 'Orquestador', role: 'orchestrator', engine: 'claude_code',
    instructions: 'reparte', allowed_tools: ['Read'],
  });
  builder = createAgent(db, {
    project_id: proyecto.id, name: 'Builder', role: 'builder', engine: 'claude_code',
    instructions: 'construye', allowed_tools: ['Read'],
  });
});

function tareaBloqueada(): Task {
  const t = createTask(db, bus, {
    project_id: proyecto.id, kind: 'build', title: 'Guardar el pedido', goal: 'Objetivo',
    required_role: 'builder', created_by: 'orchestrator',
  });
  setStatus(db, bus, t.id, 'in_progress');
  setStatus(db, bus, t.id, 'blocked', 'falta saber el formato del identificador');
  return requireTask(db, t.id);
}

describe('el orquestador ve las preguntas de los agentes', () => {
  it('el encargo lleva la pregunta con la tarea desde la que se hizo', () => {
    const t = tareaBloqueada();
    sendAgentMessage(db, bus, {
      project_id: proyecto.id, from_agent_id: builder.id, to_agent_id: orquestador.id,
      kind: 'question', body: '¿El identificador es numérico?', task_id: t.id,
    });

    const snapshot = projectSnapshot(db, proyecto.id);
    expect(snapshot.questions).toHaveLength(1);
    expect(snapshot.questions[0]).toMatchObject({ task_id: t.id, from_role: 'builder', body: '¿El identificador es numérico?' });

    const prompt = renderOrchestratorPrompt(snapshot, 'hola');
    expect(prompt).toContain('Preguntas de los agentes');
    expect(prompt).toContain('¿El identificador es numérico?');
    expect(prompt).toContain(t.id);
  });

  it('sin preguntas, el encargo no lleva el apartado', () => {
    const prompt = renderOrchestratorPrompt(projectSnapshot(db, proyecto.id), 'hola');
    expect(prompt).not.toContain('Preguntas de los agentes');
  });
});

describe('el plan puede dejar notas y reabrir tareas', () => {
  it('una nota llega a la tarea como aviso para su siguiente ejecución', () => {
    const t = tareaBloqueada();

    const r = applyPlan(db, bus, proyecto.id, {
      reply: 'Contesto al builder.',
      notes: [{ task_id: t.id, body: 'El identificador es numérico, de seis cifras.' }],
    });

    expect(r.errors).toEqual([]);
    const avisos = pendingNotices(db, t.id);
    expect(avisos.some((a) => a.from === 'orchestrator' && /seis cifras/.test(a.body))).toBe(true);
  });

  it('reabrir devuelve una tarea bloqueada a la cola, con el motivo como aviso', () => {
    const t = tareaBloqueada();

    const r = applyPlan(db, bus, proyecto.id, {
      reply: 'Ya puede seguir.',
      reopen: [{ task_id: t.id, reason: 'ya tienes el formato del identificador en la nota' }],
    });

    expect(r.errors).toEqual([]);
    expect(requireTask(db, t.id).status).toBe('ready');
    expect(pendingNotices(db, t.id).some((a) => /Se reabre/.test(a.body))).toBe(true);
  });

  it('reabrir una tarea que no está bloqueada se rechaza y se le cuenta al orquestador', () => {
    const t = createTask(db, bus, {
      project_id: proyecto.id, kind: 'build', title: 'Lista', goal: 'Objetivo',
      required_role: 'builder', created_by: 'orchestrator',
    });

    const r = applyPlan(db, bus, proyecto.id, {
      reply: 'Reabro.',
      reopen: [{ task_id: t.id, reason: 'sin motivo' }],
    });

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/no está bloqueada/);
    expect(requireTask(db, t.id).status).toBe('ready');
  });

  it('una nota a una tarea que no existe no rompe el resto del plan', () => {
    const r = applyPlan(db, bus, proyecto.id, {
      reply: 'Plan con una nota perdida.',
      notes: [{ task_id: 'tsk_no_existe', body: 'hola' }],
      tasks: [{ title: 'Nueva', goal: 'Objetivo', kind: 'build', role: 'builder' }],
    });

    expect(r.created_tasks).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
  });
});

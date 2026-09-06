import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { EventBus, listEvents } from './events.js';
import { createProject } from './projects.js';
import {
  RuleError,
  addDependency,
  createTask,
  listTasks,
  pendingDependencies,
  puedeTransicionar,
  requireTask,
  setStatus,
  taskPathPatterns,
} from './tasks.js';
import type { Project } from '../shared/types.js';

let db: Db;
let bus: EventBus;
let proyecto: Project;

beforeEach(() => {
  db = openDatabase(':memory:');
  bus = new EventBus();
  proyecto = createProject(db, { name: 'Prueba', repo_path: '/tmp/prueba' });
});

function nuevaTarea(extra: Partial<Parameters<typeof createTask>[2]> = {}) {
  return createTask(db, bus, {
    project_id: proyecto.id,
    kind: 'build',
    title: 'Tarea de prueba',
    goal: 'Objetivo',
    required_role: 'builder',
    created_by: 'creator',
    ...extra,
  });
}

describe('transiciones de estado', () => {
  it('permite las transiciones del documento 07', () => {
    expect(puedeTransicionar('ready', 'in_progress')).toBe(true);
    expect(puedeTransicionar('in_progress', 'in_review')).toBe(true);
    expect(puedeTransicionar('in_review', 'ready')).toBe(true);
    expect(puedeTransicionar('blocked', 'ready')).toBe(true);
  });

  it('rechaza saltarse el flujo', () => {
    expect(puedeTransicionar('pending', 'in_progress')).toBe(false);
    expect(puedeTransicionar('pending', 'done')).toBe(false);
    expect(puedeTransicionar('ready', 'in_review')).toBe(false);
  });

  it('no deja salir de un estado terminal', () => {
    expect(puedeTransicionar('done', 'ready')).toBe(false);
    expect(puedeTransicionar('cancelled', 'ready')).toBe(false);
  });

  it('permite cancelar desde cualquier estado no terminal', () => {
    for (const estado of ['pending', 'ready', 'in_progress', 'in_review', 'blocked'] as const) {
      expect(puedeTransicionar(estado, 'cancelled'), `desde ${estado}`).toBe(true);
    }
  });

  it('lanza un error de regla al intentar una transición no permitida', () => {
    const t = nuevaTarea();
    expect(() => setStatus(db, bus, t.id, 'done')).toThrow(RuleError);
  });

  it('guarda el motivo al bloquear y lo borra al desbloquear', () => {
    const t = nuevaTarea();
    setStatus(db, bus, t.id, 'blocked', 'falta una decisión del creador');
    expect(requireTask(db, t.id).blocked_reason).toBe('falta una decisión del creador');

    setStatus(db, bus, t.id, 'ready');
    expect(requireTask(db, t.id).blocked_reason).toBeNull();
  });

  it('marca la fecha de cierre al terminar una tarea', () => {
    const t = nuevaTarea();
    setStatus(db, bus, t.id, 'in_progress');
    setStatus(db, bus, t.id, 'done');
    expect(requireTask(db, t.id).closed_at).not.toBeNull();
  });
});

describe('creación de tareas', () => {
  it('una tarea sin dependencias queda lista al crearse', () => {
    expect(nuevaTarea().status).toBe('ready');
  });

  it('una tarea con una dependencia abierta queda pendiente', () => {
    const base = nuevaTarea();
    const dependiente = nuevaTarea({ depends_on: [base.id] });
    expect(dependiente.status).toBe('pending');
    expect(pendingDependencies(db, dependiente.id)).toEqual([base.id]);
  });

  it('cerrar una dependencia deja lista la tarea que esperaba', () => {
    const base = nuevaTarea();
    const dependiente = nuevaTarea({ depends_on: [base.id] });

    setStatus(db, bus, base.id, 'in_progress');
    setStatus(db, bus, base.id, 'done');

    expect(requireTask(db, dependiente.id).status).toBe('ready');
  });

  it('cancelar una dependencia también desbloquea', () => {
    const base = nuevaTarea();
    const dependiente = nuevaTarea({ depends_on: [base.id] });
    setStatus(db, bus, base.id, 'cancelled');
    expect(requireTask(db, dependiente.id).status).toBe('ready');
  });

  it('guarda los patrones de ruta declarados', () => {
    const t = nuevaTarea({ path_patterns: ['src/core/**', 'docs/*.md'] });
    expect(taskPathPatterns(db, t.id).sort()).toEqual(['docs/*.md', 'src/core/**']);
  });

  it('rechaza una tarea de un proyecto que no existe', () => {
    expect(() =>
      createTask(db, bus, {
        project_id: 'prj_no_existe',
        kind: 'build',
        title: 't',
        goal: 'g',
        required_role: 'builder',
        created_by: 'creator',
      }),
    ).toThrow(RuleError);
  });
});

describe('dependencias', () => {
  it('rechaza que una tarea dependa de sí misma', () => {
    const t = nuevaTarea();
    expect(() => addDependency(db, t.id, t.id)).toThrow(RuleError);
  });

  it('rechaza un ciclo directo', () => {
    const a = nuevaTarea();
    const b = nuevaTarea({ depends_on: [a.id] });
    expect(() => addDependency(db, a.id, b.id)).toThrow(/ciclo/i);
  });

  it('rechaza un ciclo indirecto de tres tareas', () => {
    const a = nuevaTarea();
    const b = nuevaTarea({ depends_on: [a.id] });
    const c = nuevaTarea({ depends_on: [b.id] });
    expect(() => addDependency(db, a.id, c.id)).toThrow(/ciclo/i);
  });

  it('rechaza depender de una tarea que no existe', () => {
    const t = nuevaTarea();
    expect(() => addDependency(db, t.id, 'tsk_no_existe')).toThrow(RuleError);
  });
});

describe('eventos', () => {
  it('crear una tarea publica su creación y su paso a lista', () => {
    nuevaTarea();
    const tipos = listEvents(db, proyecto.id).map((e) => e.type);
    expect(tipos).toContain('task.created');
    expect(tipos).toContain('task.status_changed');
  });

  it('bloquear publica también un evento de bloqueo', () => {
    const t = nuevaTarea();
    setStatus(db, bus, t.id, 'blocked', 'sin decidir');
    expect(listEvents(db, proyecto.id).map((e) => e.type)).toContain('task.blocked');
  });

  it('los suscriptores reciben los eventos en vivo', () => {
    const recibidos: string[] = [];
    bus.onProject(proyecto.id, (e) => recibidos.push(e.type));
    nuevaTarea();
    expect(recibidos).toContain('task.created');
  });

  it('se pueden pedir solo los eventos posteriores a uno dado', () => {
    nuevaTarea();
    const todos = listEvents(db, proyecto.id);
    const ultimo = todos[todos.length - 1]!;
    nuevaTarea();
    const nuevos = listEvents(db, proyecto.id, { sinceId: ultimo.id });
    expect(nuevos.length).toBeGreaterThan(0);
    expect(nuevos.every((e) => e.id > ultimo.id)).toBe(true);
  });
});

describe('listado', () => {
  it('filtra por estado y por rol', () => {
    nuevaTarea();
    nuevaTarea({ required_role: 'reviewer', kind: 'review' });
    expect(listTasks(db, proyecto.id, { role: 'reviewer' })).toHaveLength(1);
    expect(listTasks(db, proyecto.id, { status: 'ready' })).toHaveLength(2);
  });

  it('ordena por prioridad ascendente', () => {
    nuevaTarea({ title: 'baja', priority: 90 });
    nuevaTarea({ title: 'alta', priority: 10 });
    expect(listTasks(db, proyecto.id).map((t) => t.title)).toEqual(['alta', 'baja']);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PASOS, Recorrido, pasoDeLaTarea } from './Recorrido';
import { PanelAgente, pasosPorAgente } from './PanelAgente';
import { Cabecera } from './Cabecera';
import type { AgentView, ProjectOverview, SystemEvent, Task } from '../api';

function tarea(extra: Partial<Task> = {}): Task {
  return {
    id: 'tsk_1',
    project_id: 'prj_1',
    parent_task_id: null,
    kind: 'build',
    title: 'Añadir el área de proyectos',
    goal: 'Objetivo',
    scope: null,
    acceptance: null,
    required_role: 'builder',
    priority: 50,
    status: 'ready',
    assigned_agent_id: null,
    active_run_id: null,
    branch: null,
    head_commit: null,
    attempts: 0,
    blocked_reason: null,
    needs_reeval: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...extra,
  };
}

function agente(extra: Partial<AgentView> = {}): AgentView {
  return {
    id: 'agt_1',
    name: 'Builder',
    role: 'builder',
    engine: 'claude_code',
    model: null,
    allowed_tools: ['Read', 'Write'],
    max_workers: 1,
    enabled: 1,
    busy_workers: 0,
    current_tasks: [],
    queue_length: 0,
    ...extra,
  };
}

function evento(
  id: number,
  type: string,
  payload: Record<string, unknown>,
  agentId: string | null = 'agt_1',
): SystemEvent {
  return {
    id,
    project_id: 'prj_1',
    type,
    task_id: 'tsk_1',
    run_id: 'run_1',
    agent_id: agentId,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------

describe('recorrido del trabajo', () => {
  it('coloca cada tarea en su paso', () => {
    const integrables = new Set(['integrable']);

    expect(pasoDeLaTarea(tarea({ status: 'pending' }), integrables)).toBe('reparte');
    expect(pasoDeLaTarea(tarea({ status: 'ready', kind: 'build' }), integrables)).toBe('construye');
    expect(pasoDeLaTarea(tarea({ status: 'in_progress', kind: 'fix' }), integrables)).toBe('construye');
    expect(pasoDeLaTarea(tarea({ status: 'in_review' }), integrables)).toBe('revisa');
    expect(pasoDeLaTarea(tarea({ status: 'ready', kind: 'review' }), integrables)).toBe('revisa');
    expect(pasoDeLaTarea(tarea({ id: 'integrable', status: 'done' }), integrables)).toBe('integras');
    expect(pasoDeLaTarea(tarea({ status: 'blocked' }), integrables)).toBe('atascado');

    // Lo terminado sin nada que integrar, y lo cancelado, salen del recorrido.
    expect(pasoDeLaTarea(tarea({ status: 'done' }), integrables)).toBeNull();
    expect(pasoDeLaTarea(tarea({ status: 'cancelled' }), integrables)).toBeNull();
  });

  it('cuenta cuántas tareas hay en cada paso', () => {
    render(
      <Recorrido
        tareas={[
          tarea({ id: 'a', status: 'pending' }),
          tarea({ id: 'b', status: 'in_progress' }),
          tarea({ id: 'c', status: 'in_progress' }),
          tarea({ id: 'd', status: 'blocked' }),
        ]}
        integrables={[]}
        pasoSeleccionado={null}
        alSeleccionar={() => undefined}
      />,
    );

    const paso = (nombre: string) => screen.getByRole('button', { name: new RegExp(nombre) });
    expect(paso('Se reparte').textContent).toContain('1');
    expect(paso('Se construye').textContent).toContain('2');
    expect(paso('Se revisa').textContent).toContain('0');
    expect(paso('Atascado').textContent).toContain('1');
  });

  it('sin tareas atascadas no aparece el paso de atascado', () => {
    render(
      <Recorrido tareas={[tarea()]} integrables={[]} pasoSeleccionado={null} alSeleccionar={() => undefined} />,
    );
    expect(screen.queryByRole('button', { name: /Atascado/ })).toBeNull();
  });

  it('cada paso explica qué ocurre en él', () => {
    render(
      <Recorrido tareas={[]} integrables={[]} pasoSeleccionado={null} alSeleccionar={() => undefined} />,
    );
    for (const paso of PASOS) {
      expect(screen.getByTitle(paso.explicacion)).toBeDefined();
    }
  });

  it('el recorrido empieza en quien pide', () => {
    render(
      <Recorrido tareas={[]} integrables={[]} pasoSeleccionado={null} alSeleccionar={() => undefined} />,
    );
    expect(screen.getByText('Tú pides')).toBeDefined();
  });

  it('pulsar un paso filtra por él, y volver a pulsarlo quita el filtro', async () => {
    const alSeleccionar = vi.fn();
    const { rerender } = render(
      <Recorrido tareas={[]} integrables={[]} pasoSeleccionado={null} alSeleccionar={alSeleccionar} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Se construye/ }));
    expect(alSeleccionar).toHaveBeenCalledWith('construye');

    rerender(
      <Recorrido tareas={[]} integrables={[]} pasoSeleccionado="construye" alSeleccionar={alSeleccionar} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Se construye/ }));
    expect(alSeleccionar).toHaveBeenLastCalledWith(null);
  });
});

// ---------------------------------------------------------------------------

describe('panel de un agente', () => {
  it('reparte los pasos entre los agentes que los produjeron', () => {
    const pasos = pasosPorAgente([
      evento(3, 'run.progress', { text: 'leyendo validate.ts', tool: 'Read' }, 'agt_1'),
      evento(2, 'run.progress', { text: 'revisando el commit', tool: 'Read' }, 'agt_2'),
      evento(1, 'run.started', {}, 'agt_1'),
    ]);

    expect(pasos.get('agt_1')).toHaveLength(2);
    expect(pasos.get('agt_2')).toHaveLength(1);
    // Del más antiguo al más reciente, como una terminal.
    expect(pasos.get('agt_1')![0]!.texto).toBe('Empieza a trabajar');
    expect(pasos.get('agt_1')![1]!.texto).toBe('leyendo validate.ts');
  });

  it('deja fuera los eventos que no son de ningún agente', () => {
    const pasos = pasosPorAgente([evento(1, 'task.created', { task: {} }, null)]);
    expect(pasos.size).toBe(0);
  });

  it('marca los pasos que fallaron', () => {
    const pasos = pasosPorAgente([
      evento(1, 'run.progress', { text: 'npm test', tool: 'Bash', is_error: true }),
    ]);
    expect(pasos.get('agt_1')![0]!.esError).toBe(true);
  });

  it('el final de una ejecución cuenta cómo terminó', () => {
    const buena = pasosPorAgente([
      evento(1, 'run.finished', { status: 'succeeded', summary: 'He escrito la validación.' }),
    ]);
    expect(buena.get('agt_1')![0]!.texto).toContain('He escrito la validación.');
    expect(buena.get('agt_1')![0]!.esError).toBe(false);

    const mala = pasosPorAgente([
      evento(1, 'run.finished', { status: 'failed', error: 'sin credenciales' }),
    ]);
    expect(mala.get('agt_1')![0]!.esError).toBe(true);
  });

  it('muestra lo que el agente está haciendo, con su herramienta', () => {
    render(
      <PanelAgente
        agente={agente({ busy_workers: 1, current_tasks: ['tsk_1'] })}
        tareas={[tarea()]}
        pasos={[{ id: 1, hora: '12:00', texto: 'leyendo validate.ts', herramienta: 'Read', esError: false }]}
        alAbrirTarea={() => undefined}
      />,
    );

    expect(screen.getByText('leyendo validate.ts')).toBeDefined();
    expect(screen.getByText('Read')).toBeDefined();
    expect(screen.getByText('trabajando')).toBeDefined();
    expect(screen.getByText('Añadir el área de proyectos')).toBeDefined();
  });

  it('un agente libre lo dice y no muestra tarea', () => {
    render(<PanelAgente agente={agente()} tareas={[]} pasos={[]} alAbrirTarea={() => undefined} />);

    expect(screen.getByText('libre')).toBeDefined();
    expect(screen.getByText('Sin tarea asignada')).toBeDefined();
    expect(screen.getByText('Todavía no ha hecho nada.')).toBeDefined();
  });

  it('un agente con cola pero sin hueco lo dice', () => {
    render(
      <PanelAgente agente={agente({ queue_length: 3 })} tareas={[]} pasos={[]} alAbrirTarea={() => undefined} />,
    );
    expect(screen.getByText('3 en cola')).toBeDefined();
    expect(screen.getByText('Esperando un hueco para empezar')).toBeDefined();
  });

  it('al pulsar su tarea se abre el detalle', async () => {
    const alAbrirTarea = vi.fn();
    render(
      <PanelAgente
        agente={agente({ busy_workers: 1, current_tasks: ['tsk_1'] })}
        tareas={[tarea()]}
        pasos={[]}
        alAbrirTarea={alAbrirTarea}
      />,
    );

    await userEvent.click(screen.getByText('Añadir el área de proyectos'));
    expect(alAbrirTarea).toHaveBeenCalledWith('tsk_1');
  });
});

// ---------------------------------------------------------------------------

describe('cabecera', () => {
  const resumen = {
    project: {
      id: 'prj_1',
      name: 'Code Hive Factory',
      goal: null,
      repo_path: String.raw`C:\AreaDeTrabajo\codehive-factory`,
      main_branch: 'main',
      verify_command: 'npm test',
      install_command: null,
      max_concurrent_runs: 3,
      max_task_attempts: 3,
      status: 'active',
    },
    snapshot: { goal: null, decisions: [], pending_approvals: [] },
    integrable: [],
    usage: [],
    active_work: [],
    orchestrator_busy: false,
  } as ProjectOverview;

  it('dice dónde trabaja el equipo, sin tener que abrir nada', () => {
    render(
      <Cabecera
        resumen={resumen}
        agentes={[agente(), agente({ id: 'agt_2', role: 'reviewer' })]}
        tema="sistema"
        alCambiarTema={() => undefined}
        alAbrirAjustes={() => undefined}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Code Hive Factory' })).toBeDefined();
    expect(screen.getByText(resumen.project.repo_path)).toBeDefined();
    expect(screen.getByText('rama main')).toBeDefined();
    expect(screen.getByText('2 agentes en espera')).toBeDefined();
  });

  it('cuenta cuántos agentes están trabajando', () => {
    render(
      <Cabecera
        resumen={resumen}
        agentes={[agente({ busy_workers: 1 }), agente({ id: 'agt_2', role: 'reviewer' })]}
        tema="sistema"
        alCambiarTema={() => undefined}
        alAbrirAjustes={() => undefined}
      />,
    );
    expect(screen.getByText('1 de 2 agentes trabajando')).toBeDefined();
  });

  it('sin dato de consumo no se muestra ninguna cifra', () => {
    render(
      <Cabecera
        resumen={resumen}
        agentes={[agente()]}
        tema="sistema"
        alCambiarTema={() => undefined}
        alAbrirAjustes={() => undefined}
      />,
    );
    expect(screen.queryByText(/Cuota/)).toBeNull();
  });

  it('con el dato del motor muestra el porcentaje real', () => {
    render(
      <Cabecera
        resumen={{
          ...resumen,
          usage: [
            {
              engine: 'claude_code', status: 'allowed', five_hour_util: 0.37,
              five_hour_resets: new Date().toISOString(), seven_day_util: 0.1,
              seven_day_resets: new Date().toISOString(), using_overage: 0,
              updated_at: new Date().toISOString(),
            },
          ],
        }}
        agentes={[agente()]}
        tema="sistema"
        alCambiarTema={() => undefined}
        alAbrirAjustes={() => undefined}
      />,
    );
    expect(screen.getByText('Cuota 37%')).toBeDefined();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Estado, ESTADOS, haceCuanto } from './Estado';
import { Equipo } from './Equipo';
import { TarjetaTarea, Tablero, TrabajoDelProyecto } from './Tareas';
import { Chat } from './Chat';
import { Actividad, describir } from './Actividad';
import type { AgentView, ChatMessage, SystemEvent, Task, TaskStatus } from '../api';

// ---------------------------------------------------------------------------
// Datos de ejemplo
// ---------------------------------------------------------------------------

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

/** Proyecto sobre el que trabaja el equipo en las pruebas. */
const PROYECTO_DE_PRUEBA = {
  name: 'Code Hive Factory',
  repo_path: String.raw`C:\AreaDeTrabajo\codehive-factory`,
  main_branch: 'main',
};

// ---------------------------------------------------------------------------

describe('distintivo de estado', () => {
  it('cada estado se distingue por texto, no solo por color', () => {
    for (const estado of Object.keys(ESTADOS) as TaskStatus[]) {
      const { unmount } = render(<Estado estado={estado} />);
      expect(screen.getByText(ESTADOS[estado].texto)).toBeDefined();
      unmount();
    }
  });

  it('explica qué significa el estado al pasar por encima', () => {
    render(<Estado estado="blocked" />);
    const distintivo = screen.getByTitle(ESTADOS.blocked.explicacion);
    expect(distintivo.textContent).toContain('Bloqueada');
  });
});

describe('tarjeta de agente', () => {
  it('dice en qué trabaja sin abrir ningún registro', () => {
    render(
      <Equipo
        agentes={[agente({ busy_workers: 1, current_tasks: ['tsk_1'], queue_length: 3 })]}
        tareas={[tarea({ status: 'in_progress' })]}
        seleccionado={null}
        alSeleccionar={() => undefined}
      />,
    );

    expect(screen.getByText('Añadir el área de proyectos')).toBeDefined();
    expect(screen.getByText('1/1 workers')).toBeDefined();
    expect(screen.getByText('3 en cola')).toBeDefined();
    // Solo late cuando hay una ejecución de verdad en marcha.
    expect(screen.getByLabelText('Tiene una ejecución en marcha')).toBeDefined();
  });

  it('un agente sin trabajo lo dice y no late', () => {
    render(
      <Equipo agentes={[agente()]} tareas={[]} seleccionado={null} alSeleccionar={() => undefined} />,
    );

    expect(screen.getByText('Sin tarea activa')).toBeDefined();
    expect(screen.queryByLabelText('Tiene una ejecución en marcha')).toBeNull();
  });

  it('seleccionar un agente avisa a quien lo pintó', async () => {
    const alSeleccionar = vi.fn();
    render(
      <Equipo agentes={[agente()]} tareas={[]} seleccionado={null} alSeleccionar={alSeleccionar} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Builder/ }));
    expect(alSeleccionar).toHaveBeenCalledWith('agt_1');
  });
});

describe('tarjeta de tarea', () => {
  it('una tarea bloqueada dice qué le falta', () => {
    render(
      <TarjetaTarea
        tarea={tarea({ status: 'blocked', blocked_reason: 'Falta una decisión del creador.' })}
        alAbrir={() => undefined}
      />,
    );
    expect(screen.getByText('Falta una decisión del creador.')).toBeDefined();
    expect(screen.getByText('Bloqueada')).toBeDefined();
  });

  it('una tarea que espera dice por qué', () => {
    render(
      <TarjetaTarea
        tarea={tarea({ waiting_for: 'Los ficheros src/core/** los tiene reservados otra tarea.' })}
        alAbrir={() => undefined}
      />,
    );
    expect(screen.getByText(/los tiene reservados otra tarea/)).toBeDefined();
  });

  it('avisa cuando un cambio de requisito la afecta', () => {
    render(<TarjetaTarea tarea={tarea({ needs_reeval: 1 })} alAbrir={() => undefined} />);
    expect(screen.getByText(/hay que reevaluarla/)).toBeDefined();
  });

  it('muestra los hallazgos abiertos y los intentos', () => {
    render(<TarjetaTarea tarea={tarea({ findings_open: 2, attempts: 3 })} alAbrir={() => undefined} />);
    expect(screen.getByText('2 hallazgos abiertos')).toBeDefined();
    expect(screen.getByText('3 intentos')).toBeDefined();
  });

  it('al pulsarla se abre su detalle', async () => {
    const alAbrir = vi.fn();
    render(<TarjetaTarea tarea={tarea()} alAbrir={alAbrir} />);
    await userEvent.click(screen.getByRole('button'));
    expect(alAbrir).toHaveBeenCalledWith('tsk_1');
  });
});

describe('trabajo del proyecto', () => {
  it('lo que necesita atención sale primero', () => {
    render(
      <TrabajoDelProyecto
        tareas={[
          tarea({ id: 'a', title: 'Hecha', status: 'done' }),
          tarea({ id: 'b', title: 'Bloqueada', status: 'blocked' }),
          tarea({ id: 'c', title: 'Lista', status: 'ready' }),
        ]}
        agentes={[]}
        agenteSeleccionado={null}
        alAbrir={() => undefined}
      />,
    );

    const titulos = screen.getAllByRole('button').map((b) => b.querySelector('.titulo')?.textContent);
    expect(titulos).toEqual(['Bloqueada', 'Lista', 'Hecha']);
  });

  it('sin tareas invita a pedir algo en el chat', () => {
    render(
      <TrabajoDelProyecto tareas={[]} agentes={[]} agenteSeleccionado={null} alAbrir={() => undefined} />,
    );
    expect(screen.getByText(/Pide algo en el chat/)).toBeDefined();
  });

  it('filtrar por un paso explica qué se está viendo y deja quitarlo', async () => {
    const alQuitar = vi.fn();
    render(
      <TrabajoDelProyecto
        tareas={[tarea({ status: 'in_progress' })]}
        agentes={[]}
        agenteSeleccionado={null}
        alAbrir={() => undefined}
        filtro={{ paso: 'construye', alQuitar }}
      />,
    );

    expect(screen.getByText(/que se están construyendo/)).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Ver todas' }));
    expect(alQuitar).toHaveBeenCalled();
  });

  it('al elegir un agente se atenúan las tareas de otros roles', () => {
    const { container } = render(
      <TrabajoDelProyecto
        tareas={[
          tarea({ id: 'a', title: 'Del builder', required_role: 'builder' }),
          tarea({ id: 'b', title: 'Del reviewer', required_role: 'reviewer' }),
        ]}
        agentes={[agente()]}
        agenteSeleccionado="agt_1"
        alAbrir={() => undefined}
      />,
    );

    const atenuadas = container.querySelectorAll('.tarea.atenuada');
    expect(atenuadas).toHaveLength(1);
    expect(atenuadas[0]!.textContent).toContain('Del reviewer');
  });
});

describe('tablero por estados', () => {
  it('agrupa las tareas en su columna', () => {
    const { container } = render(
      <Tablero
        tareas={[
          tarea({ id: 'a', status: 'ready' }),
          tarea({ id: 'b', status: 'ready' }),
          tarea({ id: 'c', status: 'done' }),
        ]}
        alAbrir={() => undefined}
      />,
    );

    const columnas = [...container.querySelectorAll('.columna')];
    const lista = columnas.find((c) => c.textContent?.startsWith('◔Lista'))!;
    const hecha = columnas.find((c) => c.textContent?.startsWith('●Hecha'))!;

    expect(lista.querySelectorAll('.tarea')).toHaveLength(2);
    expect(hecha.querySelectorAll('.tarea')).toHaveLength(1);
  });
});

describe('chat con el orquestador', () => {
  const mensajes: ChatMessage[] = [
    { id: 'm1', author: 'creator', body: 'Añade un área de proyectos', created_at: new Date().toISOString() },
    { id: 'm2', author: 'orchestrator', body: 'De acuerdo, reparto el trabajo.', created_at: new Date().toISOString() },
  ];

  it('distingue quién dijo cada cosa', () => {
    const { container } = render(
      <Chat mensajes={mensajes} alEnviar={async () => undefined} borrador="" alCambiarBorrador={() => undefined} proyecto={PROYECTO_DE_PRUEBA} />,
    );

    expect(container.querySelector('.mensaje.del-creador')?.textContent).toContain('Añade un área de proyectos');
    expect(container.querySelector('.mensaje.del-orquestador')?.textContent).toContain('reparto el trabajo');
  });

  it('el borrador vive fuera, para que no se pierda al cambiar de vista', async () => {
    const alCambiarBorrador = vi.fn();
    render(
      <Chat mensajes={[]} alEnviar={async () => undefined} borrador="" alCambiarBorrador={alCambiarBorrador} proyecto={PROYECTO_DE_PRUEBA} />,
    );

    await userEvent.type(screen.getByLabelText('Mensaje para el orquestador'), 'hola');
    expect(alCambiarBorrador).toHaveBeenCalled();
  });

  it('no se puede enviar un mensaje vacío', () => {
    render(
      <Chat mensajes={[]} alEnviar={async () => undefined} borrador="   " alCambiarBorrador={() => undefined} proyecto={PROYECTO_DE_PRUEBA} />,
    );
    expect(screen.getByRole('button', { name: 'Enviar' })).toHaveProperty('disabled', true);
  });

  it('envía el mensaje al pulsar el botón', async () => {
    const alEnviar = vi.fn(async () => undefined);
    render(
      <Chat mensajes={[]} alEnviar={alEnviar} borrador="Añade el filtro" alCambiarBorrador={() => undefined} proyecto={PROYECTO_DE_PRUEBA} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(alEnviar).toHaveBeenCalledWith('Añade el filtro');
  });

  it('antes del primer mensaje dice dónde se va a trabajar', () => {
    render(
      <Chat mensajes={[]} alEnviar={async () => undefined} borrador="" alCambiarBorrador={() => undefined} proyecto={PROYECTO_DE_PRUEBA} />,
    );
    expect(screen.getByText(PROYECTO_DE_PRUEBA.repo_path)).toBeDefined();
    expect(screen.getByText(/Nada llega a la rama main sin que tú lo confirmes/)).toBeDefined();
  });
});

describe('actividad', () => {
  const evento = (type: string, payload: Record<string, unknown>, id = 1): SystemEvent => ({
    id,
    project_id: 'prj_1',
    type,
    task_id: 'tsk_1',
    run_id: null,
    agent_id: null,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
  });

  it('traduce los eventos a frases que se entienden', () => {
    expect(describir(evento('increment.published', { message: 'validación de nombres' })))
      .toBe('Incremento publicado: validación de nombres');

    expect(describir(evento('finding.opened', { severity: 'blocker', title: 'Acepta cadena vacía' })))
      .toBe('Hallazgo blocker: Acepta cadena vacía');

    expect(describir(evento('integration.completed', { integrated: true, branch: 'task/uno' })))
      .toBe('Rama integrada en la principal: task/uno');

    expect(describir(evento('integration.completed', { integrated: false, reason: 'conflicto' })))
      .toBe('No se pudo integrar: conflicto');
  });

  it('deja fuera lo que ya se ve en otro sitio', () => {
    // El detalle paso a paso vive dentro de la tarea, y la conversación tiene su panel.
    expect(describir(evento('run.progress', { text: 'leyendo un fichero' }))).toBeNull();
    expect(describir(evento('chat.message', { body: 'hola' }))).toBeNull();
    expect(describir(evento('task.status_changed', { from: 'ready', to: 'in_progress' }))).toBeNull();
  });

  it('al pulsar un evento se abre su tarea', async () => {
    const alAbrirTarea = vi.fn();
    render(
      <Actividad
        eventos={[evento('increment.published', { message: 'un cambio' })]}
        alAbrirTarea={alAbrirTarea}
      />,
    );

    await userEvent.click(screen.getByText('Incremento publicado: un cambio'));
    expect(alAbrirTarea).toHaveBeenCalledWith('tsk_1');
  });

  it('sin nada que contar lo dice', () => {
    render(<Actividad eventos={[]} alAbrirTarea={() => undefined} />);
    expect(screen.getByText('Todavía no ha pasado nada.')).toBeDefined();
  });
});

describe('tiempo en palabras', () => {
  it('dice cuánto hace de algo', () => {
    const hace = (ms: number) => haceCuanto(new Date(Date.now() - ms).toISOString());

    expect(hace(5_000)).toBe('hace un momento');
    expect(hace(5 * 60_000)).toBe('hace 5 min');
    expect(hace(3 * 3_600_000)).toBe('hace 3 h');
    expect(hace(2 * 86_400_000)).toBe('hace 2 días');
  });
});

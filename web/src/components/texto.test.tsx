import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Texto } from './Texto';
import { PanelAgente, pasosPorAgente, trozosDelPaso } from './PanelAgente';
import type { AgentView } from '../api';

describe('texto de los agentes', () => {
  it('los dobles asteriscos se pintan como resalte, no en crudo', () => {
    const { container } = render(<Texto>{'He creado **una tarea** para el builder.'}</Texto>);

    expect(container.querySelector('strong')?.textContent).toBe('una tarea');
    // Y no queda ningún asterisco a la vista.
    expect(container.textContent).not.toContain('*');
  });

  it('las comillas invertidas se pintan como código', () => {
    const { container } = render(<Texto>{'El dato está en `src/core/roles.ts`.'}</Texto>);

    expect(container.querySelector('code')?.textContent).toBe('src/core/roles.ts');
    expect(container.textContent).not.toContain('`');
  });

  it('las listas con guiones se pintan como lista', () => {
    const { container } = render(
      <Texto>{'Voy a hacer esto:\n- Primero una cosa\n- Después otra'}</Texto>,
    );

    const puntos = container.querySelectorAll('li');
    expect(puntos).toHaveLength(2);
    expect(puntos[0]!.textContent).toBe('Primero una cosa');
    expect(container.textContent).not.toContain('- Primero');
  });

  it('las listas numeradas también', () => {
    const { container } = render(<Texto>{'1. Uno\n2. Dos\n3. Tres'}</Texto>);
    expect(container.querySelectorAll('li')).toHaveLength(3);
  });

  it('cada línea suelta es su propio párrafo', () => {
    const { container } = render(<Texto>{'Primera línea.\nSegunda línea.'}</Texto>);
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });

  it('el resalte dentro de una lista también se pinta', () => {
    const { container } = render(<Texto>{'- La tarea **está lista**'}</Texto>);
    expect(container.querySelector('li strong')?.textContent).toBe('está lista');
  });

  it('un asterisco suelto no rompe nada', () => {
    const { container } = render(<Texto>{'Multiplica 2 * 3 y dime el resultado.'}</Texto>);
    expect(container.textContent).toContain('2 * 3');
  });
});

describe('lo que el agente dice no se corta', () => {
  it('un mensaje largo se enseña entero, no resumido a una frase', () => {
    const dicho = 'He terminado la investigación. '.repeat(20);
    const pasos = pasosPorAgente([
      {
        id: 1,
        project_id: 'prj_1',
        type: 'run.progress',
        task_id: 'tsk_1',
        run_id: 'run_1',
        agent_id: 'agt_1',
        payload: JSON.stringify({ kind: 'message', text: dicho }),
        created_at: new Date().toISOString(),
      },
    ]);

    expect(pasos.get('agt_1')![0]!.texto).toBe(dicho.trim());
    expect(pasos.get('agt_1')![0]!.texto.endsWith('…')).toBe(false);
  });

  it('en cambio, la salida de una herramienta sí se resume', () => {
    const salida = 'una línea de salida cualquiera '.repeat(20);
    const pasos = pasosPorAgente([
      {
        id: 1,
        project_id: 'prj_1',
        type: 'run.progress',
        task_id: 'tsk_1',
        run_id: 'run_1',
        agent_id: 'agt_1',
        payload: JSON.stringify({ kind: 'tool_result', text: salida }),
        created_at: new Date().toISOString(),
      },
    ]);

    expect(pasos.get('agt_1')![0]!.texto.endsWith('…')).toBe(true);
  });
});

describe('resaltado dentro de un paso', () => {
  const destacados = (texto: string) =>
    trozosDelPaso(texto).filter((t) => t.destacado).map((t) => t.texto);

  it('resalta la ruta de un fichero', () => {
    expect(destacados('lee core/roles.ts para entender el reparto')).toEqual(['core/roles.ts']);
  });

  it('resalta un nombre de fichero suelto', () => {
    expect(destacados('escribe README.md')).toEqual(['README.md']);
  });

  it('resalta las opciones de un comando', () => {
    expect(destacados('npm run build --silent')).toContain('--silent');
  });

  it('una frase sin datos no resalta nada', () => {
    expect(destacados('Empieza a trabajar')).toEqual([]);
  });

  it('el texto sale entero aunque se parta en trozos', () => {
    const texto = 'edita src/core/db.ts y ejecuta npm test';
    expect(trozosDelPaso(texto).map((t) => t.texto).join('')).toBe(texto);
  });

  it('no parte una palabra española con guion en medio', () => {
    expect(destacados('revisa el paso-a-paso del flujo')).toEqual([]);
  });
});

describe('color de cada agente', () => {
  function agente(extra: Partial<AgentView> = {}): AgentView {
    return {
      id: 'agt_1',
      name: 'Builder',
      role: 'builder',
      engine: 'claude_code',
      model: null,
      allowed_tools: [],
      max_workers: 1,
      enabled: 1,
      busy_workers: 0,
      current_tasks: [],
      queue_length: 0,
      ...extra,
    };
  }

  it('cada rol lleva su propio color', () => {
    const roles: Array<[AgentView['role'], string]> = [
      ['orchestrator', 'orquestador'],
      ['builder', 'builder'],
      ['reviewer', 'reviewer'],
      ['researcher', 'investigador'],
    ];

    for (const [rol, color] of roles) {
      const { container, unmount } = render(
        <PanelAgente agente={agente({ role: rol })} tareas={[]} pasos={[]} alAbrirTarea={() => undefined} />,
      );
      expect(container.querySelector('.agente-panel')?.getAttribute('data-rol')).toBe(color);
      unmount();
    }
  });

  it('el recorte junta los espacios, sin comerse las letras', () => {
    const pasos = pasosPorAgente([
      {
        id: 1,
        project_id: 'prj_1',
        type: 'run.progress',
        task_id: 'tsk_1',
        run_id: 'run_1',
        agent_id: 'agt_1',
        payload: JSON.stringify({ text: 'casos  sueltos\n  con espacios' }),
        created_at: new Date().toISOString(),
      },
    ]);

    expect(pasos.get('agt_1')![0]!.texto).toBe('casos sueltos con espacios');
  });

  it('un resumen larguísimo se recorta, pero muy por encima de una frase', () => {
    const pasos = pasosPorAgente([
      {
        id: 1,
        project_id: 'prj_1',
        type: 'run.finished',
        task_id: 'tsk_1',
        run_id: 'run_1',
        agent_id: 'agt_1',
        payload: JSON.stringify({ status: 'succeeded', summary: 'Una frase larga. '.repeat(60) }),
        created_at: new Date().toISOString(),
      },
    ]);

    // Se lee casi entero en el panel. El texto completo está en la tarea.
    expect(pasos.get('agt_1')![0]!.texto.length).toBeGreaterThan(400);
    expect(pasos.get('agt_1')![0]!.texto.length).toBeLessThan(700);
    expect(pasos.get('agt_1')![0]!.texto.endsWith('…')).toBe(true);
  });

  it('cada paso dice de qué clase es, para pintarlo distinto', () => {
    const evento = (kind: string, id: number) => ({
      id,
      project_id: 'prj_1',
      type: 'run.progress',
      task_id: 'tsk_1',
      run_id: 'run_1',
      agent_id: 'agt_1',
      payload: JSON.stringify({ kind, text: 'algo' }),
      created_at: new Date().toISOString(),
    });

    const pasos = pasosPorAgente([evento('tool_use', 1), evento('tool_result', 2), evento('message', 3)]);
    expect(pasos.get('agt_1')!.map((p) => p.clase)).toEqual(['dice', 'recibe', 'hace']);
  });

  it('el texto de un paso se puede leer entero, no recortado a una línea', () => {
    const largo = 'lee src/core/orchestrator.ts para entender cómo se reparte el trabajo';
    const { container } = render(
      <PanelAgente
        agente={agente()}
        tareas={[]}
        pasos={[{ id: 1, hora: '12:00', texto: largo, herramienta: 'Read', esError: false, clase: 'hace' }]}
        alAbrirTarea={() => undefined}
      />,
    );
    // El texto va partido en trozos para poder resaltar la ruta, pero está entero.
    expect(container.querySelector('.paso-agente .texto')?.textContent).toBe(largo);
  });
});

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Texto } from './Texto';
import { PanelAgente } from './PanelAgente';
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

  it('el texto de un paso se puede leer entero, no recortado a una línea', () => {
    const largo = 'lee src/core/orchestrator.ts para entender cómo se reparte el trabajo';
    render(
      <PanelAgente
        agente={agente()}
        tareas={[]}
        pasos={[{ id: 1, hora: '12:00', texto: largo, herramienta: 'Read', esError: false }]}
        alAbrirTarea={() => undefined}
      />,
    );
    expect(screen.getByText(largo)).toBeDefined();
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { createAgent, createProject, listAgents, setAgentEngine, sincronizarAgentes } from './projects.js';
import { MODELO_POR_ROL, ROLE_DEFAULTS, modeloPara } from './roles.js';
import type { Project } from '../shared/types.js';

let db: Db;
let proyecto: Project;

beforeEach(() => {
  db = openDatabase(':memory:');
  proyecto = createProject(db, { name: 'Prueba', repo_path: '/tmp/prueba' });
});

describe('herramientas de cada rol', () => {
  it('solo el investigador puede salir a internet', () => {
    expect(ROLE_DEFAULTS.researcher.tools).toContain('WebSearch');
    expect(ROLE_DEFAULTS.researcher.tools).toContain('WebFetch');

    for (const rol of ['orchestrator', 'builder', 'reviewer', 'refactorer'] as const) {
      expect(ROLE_DEFAULTS[rol].tools).not.toContain('WebSearch');
      expect(ROLE_DEFAULTS[rol].tools).not.toContain('WebFetch');
    }
  });

  it('quien escribe código lleva la lista de pasos del motor', () => {
    expect(ROLE_DEFAULTS.builder.tools).toContain('TodoWrite');
    expect(ROLE_DEFAULTS.refactorer.tools).toContain('TodoWrite');
  });

  it('quien no debe escribir no tiene con qué', () => {
    for (const rol of ['orchestrator', 'reviewer', 'researcher'] as const) {
      expect(ROLE_DEFAULTS[rol].tools).not.toContain('Write');
      expect(ROLE_DEFAULTS[rol].tools).not.toContain('Edit');
    }
  });
});

describe('modelo de cada rol', () => {
  it('con Claude Code se fija un modelo explícito', () => {
    expect(modeloPara('builder', 'claude_code')).toBe(MODELO_POR_ROL.builder);
  });

  it('con Codex no se fija ninguno, porque sus modelos los nombra su propio ejecutable', () => {
    expect(modeloPara('builder', 'codex')).toBeNull();
  });
});

describe('sincronización del equipo al arrancar', () => {
  /** Un agente como los que dejaban las versiones anteriores: sin modelo y sin TodoWrite. */
  function agenteAntiguo() {
    return createAgent(db, {
      project_id: proyecto.id,
      name: 'Builder',
      role: 'builder',
      engine: 'claude_code',
      instructions: 'construye',
      allowed_tools: ['Read', 'Write'],
      model: null,
    });
  }

  it('un agente que ya existía recibe las herramientas y el modelo que declara el código', () => {
    const antiguo = agenteAntiguo();
    expect(sincronizarAgentes(db, proyecto.id)).toHaveLength(1);

    const actualizado = listAgents(db, proyecto.id).find((a) => a.id === antiguo.id)!;
    expect(JSON.parse(actualizado.allowed_tools)).toEqual(ROLE_DEFAULTS.builder.tools);
    expect(actualizado.model).toBe(MODELO_POR_ROL.builder);
  });

  it('un agente que ya está al día no se toca', () => {
    agenteAntiguo();
    sincronizarAgentes(db, proyecto.id);
    expect(sincronizarAgentes(db, proyecto.id)).toEqual([]);
  });

  it('cambiar de motor ajusta el modelo, porque el anterior no significa nada en el otro', () => {
    const agente = agenteAntiguo();
    sincronizarAgentes(db, proyecto.id);

    expect(setAgentEngine(db, agente.id, 'codex').model).toBeNull();
    expect(setAgentEngine(db, agente.id, 'claude_code').model).toBe(MODELO_POR_ROL.builder);
  });
});

describe('configuración personal del proyecto', () => {
  it('un proyecto nuevo nace aislado', () => {
    expect(proyecto.use_personal_config).toBe(0);
    expect(proyecto.protected_paths).toBe('[]');
  });
});

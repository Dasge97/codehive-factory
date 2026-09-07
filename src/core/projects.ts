import type { Db } from './db.js';
import { newId, now } from '../shared/ids.js';
import type { Agent, AgentRole, Decision, EngineName, Project, ProjectMode } from '../shared/types.js';

export interface CreateProjectInput {
  name: string;
  repo_path: string;
  main_branch?: string;
  goal?: string | null;
  verify_command?: string | null;
  install_command?: string | null;
  max_concurrent_runs?: number;
  max_task_attempts?: number;
  run_timeout_ms?: number;
}

export function createProject(db: Db, input: CreateProjectInput): Project {
  const id = newId('project');
  const momento = now();
  db.prepare(
    `INSERT INTO projects (
       id, name, repo_path, main_branch, goal, verify_command, install_command,
       max_concurrent_runs, max_task_attempts, run_timeout_ms, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    id,
    input.name,
    input.repo_path,
    input.main_branch ?? 'main',
    input.goal ?? null,
    input.verify_command ?? null,
    input.install_command ?? null,
    input.max_concurrent_runs ?? 4,
    input.max_task_attempts ?? 3,
    input.run_timeout_ms ?? 900_000,
    momento,
    momento,
  );
  return requireProject(db, id);
}

export function getProject(db: Db, id: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}

export function requireProject(db: Db, id: string): Project {
  const p = getProject(db, id);
  if (!p) throw new Error(`El proyecto ${id} no existe.`);
  return p;
}

export function listProjects(db: Db): Project[] {
  return db.prepare("SELECT * FROM projects WHERE status <> 'archived' ORDER BY name").all() as Project[];
}

export function setProjectGoal(db: Db, id: string, goal: string): void {
  db.prepare('UPDATE projects SET goal = ?, updated_at = ? WHERE id = ?').run(goal, now(), id);
}

// ---------------------------------------------------------------------------
// Agentes
// ---------------------------------------------------------------------------

export interface CreateAgentInput {
  project_id: string;
  name: string;
  role: AgentRole;
  engine: EngineName;
  instructions: string;
  allowed_tools: string[];
  model?: string | null;
  max_workers?: number;
}

export function createAgent(db: Db, input: CreateAgentInput): Agent {
  const id = newId('agent');
  const momento = now();
  db.prepare(
    `INSERT INTO agents (
       id, project_id, name, role, engine, model, instructions, allowed_tools,
       max_workers, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    input.project_id,
    input.name,
    input.role,
    input.engine,
    input.model ?? null,
    input.instructions,
    JSON.stringify(input.allowed_tools),
    input.max_workers ?? 1,
    momento,
    momento,
  );
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent;
}

export function listAgents(db: Db, projectId: string): Agent[] {
  return db
    .prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY role')
    .all(projectId) as Agent[];
}

export function agentForRole(db: Db, projectId: string, role: AgentRole): Agent | undefined {
  return db
    .prepare('SELECT * FROM agents WHERE project_id = ? AND role = ? AND enabled = 1 LIMIT 1')
    .get(projectId, role) as Agent | undefined;
}

export function agentTools(agent: Agent): string[] {
  return JSON.parse(agent.allowed_tools) as string[];
}

// ---------------------------------------------------------------------------
// Decisiones
// ---------------------------------------------------------------------------

/**
 * Registra una decisión de producto. Cada una lleva un número de revisión creciente
 * dentro del proyecto: las tareas guardan con qué revisión se crearon, para saber cuáles
 * hay que reevaluar cuando el creador cambia algo.
 */
export function recordDecision(
  db: Db,
  input: { project_id: string; title: string; body: string; decided_by: string; supersedes_id?: string | null },
): Decision {
  const fila = db
    .prepare('SELECT COALESCE(MAX(revision), 0) AS max FROM decisions WHERE project_id = ?')
    .get(input.project_id) as { max: number };

  const id = newId('decision');
  db.prepare(
    `INSERT INTO decisions (id, project_id, revision, title, body, supersedes_id, decided_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.project_id,
    fila.max + 1,
    input.title,
    input.body,
    input.supersedes_id ?? null,
    input.decided_by,
    now(),
  );
  return db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Decision;
}

/**
 * Decisiones vigentes: las que no han sido sustituidas por otra posterior. Son las que se
 * entregan a los agentes en su encargo.
 */
export function currentDecisions(db: Db, projectId: string): Decision[] {
  return db
    .prepare(
      `SELECT * FROM decisions d
       WHERE d.project_id = ?
         AND NOT EXISTS (SELECT 1 FROM decisions s WHERE s.supersedes_id = d.id)
       ORDER BY d.revision`,
    )
    .all(projectId) as Decision[];
}

export function currentRevision(db: Db, projectId: string): number {
  const fila = db
    .prepare('SELECT COALESCE(MAX(revision), 0) AS max FROM decisions WHERE project_id = ?')
    .get(projectId) as { max: number };
  return fila.max;
}

// ---------------------------------------------------------------------------
// Cambios sobre un proyecto ya registrado
// ---------------------------------------------------------------------------

export interface UpdateProjectInput {
  goal?: string | null;
  verify_command?: string | null;
  install_command?: string | null;
  max_concurrent_runs?: number;
  max_task_attempts?: number;
  run_timeout_ms?: number;
  status?: Project['status'];
  mode?: ProjectMode;
}

/** Cambia la configuración de un proyecto. Solo toca los campos que se le pasan. */
export function updateProject(db: Db, id: string, cambios: UpdateProjectInput): Project {
  const columnas: string[] = [];
  const valores: unknown[] = [];

  for (const [campo, valor] of Object.entries(cambios)) {
    if (valor === undefined) continue;
    columnas.push(`${campo} = ?`);
    valores.push(valor);
  }

  if (columnas.length > 0) {
    columnas.push('updated_at = ?');
    valores.push(now(), id);
    db.prepare(`UPDATE projects SET ${columnas.join(', ')} WHERE id = ?`).run(...valores);
  }

  return requireProject(db, id);
}

/**
 * Pone en pausa un proyecto o lo reanuda.
 *
 * Un proyecto en pausa conserva todo su trabajo: el supervisor deja de arrancar workers,
 * pero las tareas siguen donde estaban y siguen viéndose en la web.
 */
export function setProjectStatus(db: Db, id: string, status: Project['status']): Project {
  return updateProject(db, id, { status });
}

/**
 * Cambia el modo de trabajo del proyecto.
 *
 * El cambio solo afecta a las tareas que se creen a partir de ahora. Las que ya están en
 * marcha terminan con las reglas con las que empezaron.
 */
export function setProjectMode(db: Db, id: string, mode: ProjectMode): Project {
  return updateProject(db, id, { mode });
}

/** Cambia el motor con el que se ejecuta un agente. */
export function setAgentEngine(db: Db, agentId: string, engine: EngineName): Agent {
  db.prepare('UPDATE agents SET engine = ?, updated_at = ? WHERE id = ?').run(engine, now(), agentId);
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Agent | undefined;
  if (!agent) throw new Error(`El agente ${agentId} no existe.`);
  return agent;
}

/** Activa o desactiva un agente. Un agente desactivado no recibe trabajo. */
export function setAgentEnabled(db: Db, agentId: string, enabled: boolean): Agent {
  db.prepare('UPDATE agents SET enabled = ?, updated_at = ? WHERE id = ?').run(
    enabled ? 1 : 0,
    now(),
    agentId,
  );
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Agent | undefined;
  if (!agent) throw new Error(`El agente ${agentId} no existe.`);
  return agent;
}

/** Cuántos workers como mucho puede tener un agente a la vez. */
export function setAgentWorkers(db: Db, agentId: string, maxWorkers: number): Agent {
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 8) {
    throw new Error('El número de workers debe ser un entero entre 1 y 8.');
  }
  db.prepare('UPDATE agents SET max_workers = ?, updated_at = ? WHERE id = ?').run(
    maxWorkers,
    now(),
    agentId,
  );
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Agent;
}

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Db } from '../core/db.js';
import { EventBus, appendEvent } from '../core/events.js';
import { buildAssignment, renderAssignment } from '../core/assignment.js';
import { agentTools, requireProject } from '../core/projects.js';
import { openFindings, publishIncrement } from '../core/review.js';
import { markNoticesDelivered, requireTask, setStatus } from '../core/tasks.js';
import { newId, now } from '../shared/ids.js';
import {
  AGENT_RESULT_JSON_SCHEMA,
  agentResultSchema,
  type Agent,
  type AgentResult,
  type Run,
  type Task,
} from '../shared/types.js';
import type { Engine, EngineRunOutcome } from '../engines/types.js';
import { changedFiles, ensureWorktree, lastCommit, resolveCommit } from './git.js';

const execFileAsync = promisify(execFile);

/** Raíz donde viven los worktrees de las tareas. */
export function workspacesRoot(): string {
  return process.env['CODEHIVE_WORKSPACES'] ?? join(process.cwd(), 'workspaces');
}

/** Nombre de la rama de una tarea (decisión D09). */
export function branchForTask(taskId: string): string {
  return `task/${taskId}`;
}

/** Tipos de tarea que escriben código y por tanto necesitan su propio espacio aislado. */
const ESCRIBEN_CODIGO = new Set(['build', 'fix']);

export interface RunTaskInput {
  task: Task;
  agent: Agent;
  run: Run;
  engine: Engine;
}

export interface RunTaskResult {
  outcome: EngineRunOutcome;
  result: AgentResult | null;
  parseError: string | null;
  incrementId: string | null;
}

/**
 * Ejecuta una tarea de principio a fin: prepara el espacio de trabajo, redacta el
 * encargo, lanza el motor, y guarda lo que salga.
 *
 * Todo lo que el motor devuelve pasa por validación antes de tocar la base de datos. Un
 * resultado que no cumple el contrato deja la ejecución como fallida con un motivo claro,
 * en lugar de guardar datos a medias.
 */
export async function runTask(
  db: Db,
  bus: EventBus,
  input: RunTaskInput,
): Promise<RunTaskResult> {
  const { task, agent, run, engine } = input;
  const project = requireProject(db, task.project_id);

  const workspace = await prepareWorkspace(db, task, project.repo_path, project.main_branch, project.install_command);

  const assignment = buildAssignment(db, task.id);
  const prompt = renderAssignment(assignment);
  markNoticesDelivered(db, task.id);

  const handle = engine.start(
    {
      prompt,
      cwd: workspace.path,
      allowedTools: agentTools(agent),
      timeoutMs: project.run_timeout_ms,
      model: agent.model,
      resultSchema: AGENT_RESULT_JSON_SCHEMA,
      systemPromptAppend: agent.instructions,
      sessionId: run.engine_session_id ?? undefined,
      resumeSessionId: previousSessionId(db, task.id),
      permissionMode: ESCRIBEN_CODIGO.has(task.kind) ? 'acceptEdits' : 'manual',
    },
    (progreso) => {
      appendEvent(db, bus, {
        project_id: task.project_id,
        type: 'run.progress',
        task_id: task.id,
        run_id: run.id,
        agent_id: agent.id,
        payload: { kind: progreso.kind, tool: progreso.tool ?? null, text: progreso.text, is_error: progreso.isError ?? false },
      });
    },
  );

  const outcome = await handle.wait();

  saveUsage(db, bus, engine.name, outcome);
  const denegaciones = saveApprovals(db, bus, task, run, outcome);

  const { result, parseError } = parseResult(outcome.resultText);

  const incrementId = await recordWork(db, bus, {
    task,
    run,
    project_repo: project.repo_path,
    workspacePath: workspace.path,
    baseCommit: workspace.baseCommit,
    result,
  });

  finishRun(db, bus, { task, agent, run, outcome, result, parseError, denegaciones, maxAttempts: project.max_task_attempts });

  return { outcome, result, parseError, incrementId };
}

// ---------------------------------------------------------------------------
// Espacio de trabajo
// ---------------------------------------------------------------------------

async function prepareWorkspace(
  db: Db,
  task: Task,
  repoPath: string,
  mainBranch: string,
  installCommand: string | null,
): Promise<{ path: string; baseCommit: string }> {
  // Las tareas que solo leen trabajan sobre el repositorio principal: crearles un worktree
  // costaría tiempo y disco sin darles nada.
  if (!ESCRIBEN_CODIGO.has(task.kind)) {
    const ruta = task.workspace_path ?? repoPath;
    return { path: ruta, baseCommit: task.base_commit ?? (await resolveCommit(repoPath, 'HEAD')) };
  }

  // Una corrección continúa en la rama del trabajo que corrige, no en una nueva.
  const rama = task.branch ?? branchForTask(task.parent_task_id ?? task.id);
  const ruta = task.workspace_path ?? join(workspacesRoot(), task.parent_task_id ?? task.id);

  const { created, baseCommit } = await ensureWorktree(repoPath, ruta, rama, mainBranch);

  if (created && installCommand) {
    await ejecutarComando(installCommand, ruta).catch(() => undefined);
  }

  db.prepare(
    'UPDATE tasks SET workspace_path = ?, branch = ?, base_commit = COALESCE(base_commit, ?), updated_at = ? WHERE id = ?',
  ).run(ruta, rama, baseCommit, now(), task.id);

  return { path: ruta, baseCommit: task.base_commit ?? baseCommit };
}

async function ejecutarComando(comando: string, cwd: string): Promise<{ ok: boolean; salida: string }> {
  const partes = comando.split(' ').filter(Boolean);
  const programa = partes[0];
  if (!programa) return { ok: false, salida: 'comando vacío' };

  try {
    const { stdout, stderr } = await execFileAsync(programa, partes.slice(1), {
      cwd,
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    return { ok: true, salida: (stdout + stderr).slice(-4000) };
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, salida: ((error.stdout ?? '') + (error.stderr ?? '') + (error.message ?? '')).slice(-4000) };
  }
}

/** Sesión del motor que dejó el intento anterior sobre esta tarea, si la hubo. */
function previousSessionId(db: Db, taskId: string): string | null {
  const fila = db
    .prepare(
      `SELECT engine_session_id FROM runs
       WHERE task_id = ? AND engine_session_id IS NOT NULL AND status <> 'running'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(taskId) as { engine_session_id: string } | undefined;
  return fila?.engine_session_id ?? null;
}

// ---------------------------------------------------------------------------
// Lectura del resultado
// ---------------------------------------------------------------------------

/**
 * Convierte y valida el resultado del agente.
 *
 * El motor lo devuelve como texto que cumple el esquema, pero se vuelve a comprobar aquí:
 * lo que entra en la base de datos siempre pasa por validación, venga de donde venga.
 */
export function parseResult(texto: string | null): { result: AgentResult | null; parseError: string | null } {
  if (!texto || !texto.trim()) {
    return { result: null, parseError: 'El agente no devolvió ningún resultado.' };
  }

  let crudo: unknown;
  try {
    crudo = JSON.parse(texto);
  } catch {
    return { result: null, parseError: `El resultado del agente no es JSON válido: ${texto.slice(0, 200)}` };
  }

  const validado = agentResultSchema.safeParse(crudo);
  if (!validado.success) {
    const problemas = validado.error.issues
      .map((i) => `${i.path.join('.') || 'raíz'}: ${i.message}`)
      .join('; ');
    return { result: null, parseError: `El resultado del agente no cumple el contrato: ${problemas}` };
  }

  return { result: validado.data, parseError: null };
}

// ---------------------------------------------------------------------------
// Guardado
// ---------------------------------------------------------------------------

function saveUsage(db: Db, bus: EventBus, engine: string, outcome: EngineRunOutcome): void {
  if (!outcome.usage) return;
  const u = outcome.usage;

  db.prepare(
    `INSERT INTO engine_usage (engine, status, five_hour_util, five_hour_resets, seven_day_util, seven_day_resets, using_overage, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(engine) DO UPDATE SET
       status = excluded.status,
       five_hour_util = excluded.five_hour_util,
       five_hour_resets = excluded.five_hour_resets,
       seven_day_util = excluded.seven_day_util,
       seven_day_resets = excluded.seven_day_resets,
       using_overage = excluded.using_overage,
       updated_at = excluded.updated_at`,
  ).run(
    engine,
    u.status,
    u.fiveHourUtilization,
    u.fiveHourResetsAt,
    u.sevenDayUtilization,
    u.sevenDayResetsAt,
    u.usingOverage ? 1 : 0,
    now(),
  );
}

/**
 * Convierte en peticiones de autorización las acciones que el motor denegó por falta de
 * permiso (decisión D22). El creador las resuelve desde la web y el siguiente intento de
 * la tarea puede llevarlas ya permitidas.
 */
function saveApprovals(db: Db, bus: EventBus, task: Task, run: Run, outcome: EngineRunOutcome): number {
  for (const denegacion of outcome.permissionDenials) {
    const id = newId('approval');
    db.prepare(
      `INSERT INTO approvals (id, run_id, task_id, kind, request, tool_name, tool_input, status, created_at)
       VALUES (?, ?, ?, 'tool_use', ?, ?, ?, 'pending', ?)`,
    ).run(
      id,
      run.id,
      task.id,
      `El agente intentó usar ${denegacion.tool_name} y no tenía permiso.`,
      denegacion.tool_name,
      JSON.stringify(denegacion.tool_input),
      now(),
    );

    appendEvent(db, bus, {
      project_id: task.project_id,
      type: 'approval.requested',
      task_id: task.id,
      run_id: run.id,
      payload: { approval_id: id, tool_name: denegacion.tool_name, tool_input: denegacion.tool_input },
    });
  }
  return outcome.permissionDenials.length;
}

interface RecordWorkInput {
  task: Task;
  run: Run;
  project_repo: string;
  workspacePath: string;
  baseCommit: string;
  result: AgentResult | null;
}

/**
 * Guarda lo que el agente produjo: el incremento si publicó un commit, o los hallazgos si
 * era una revisión.
 */
async function recordWork(db: Db, bus: EventBus, input: RecordWorkInput): Promise<string | null> {
  const { task, run, result } = input;
  if (!result) return null;

  if (task.kind === 'review') {
    const incremento = db
      .prepare('SELECT id FROM increments WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(task.parent_task_id ?? '') as { id: string } | undefined;

    if (incremento) {
      openFindings(db, bus, {
        review_task_id: task.id,
        increment_id: incremento.id,
        findings: result.findings ?? [],
      });
    }
    return null;
  }

  if (!ESCRIBEN_CODIGO.has(task.kind)) return null;

  // Se toma el commit real del worktree, no el que diga el agente: si se equivoca de
  // identificador, el incremento apuntaría a algo que no existe.
  const commit = await lastCommit(input.workspacePath);
  if (!commit || commit.sha === input.baseCommit) return null;

  const ficheros = await changedFiles(input.workspacePath, input.baseCommit, commit.sha).catch(() => []);

  const publicado = publishIncrement(db, bus, {
    task_id: task.id,
    run_id: run.id,
    commit_sha: commit.sha,
    branch: task.branch ?? branchForTask(task.id),
    message: commit.message,
    files: ficheros,
  });

  return publicado.increment.id;
}

interface FinishRunInput {
  task: Task;
  agent: Agent;
  run: Run;
  outcome: EngineRunOutcome;
  result: AgentResult | null;
  parseError: string | null;
  denegaciones: number;
  maxAttempts: number;
}

/** Cierra la ejecución y deja la tarea en el estado que corresponda. */
function finishRun(db: Db, bus: EventBus, input: FinishRunInput): void {
  const { task, run, outcome, result, parseError, maxAttempts } = input;

  const fallo = outcome.status !== 'succeeded' ? outcome.error : parseError;
  const estadoRun =
    outcome.status !== 'succeeded' ? outcome.status : parseError ? 'failed' : 'succeeded';

  db.prepare(
    `UPDATE runs SET status = ?, engine_session_id = ?, output_commit = ?, summary = ?,
                     error = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, ended_at = ?
     WHERE id = ?`,
  ).run(
    estadoRun,
    outcome.sessionId,
    result?.commit ?? null,
    result?.summary ?? null,
    fallo,
    outcome.inputTokens,
    outcome.outputTokens,
    outcome.costUsd,
    now(),
    run.id,
  );

  appendEvent(db, bus, {
    project_id: task.project_id,
    type: 'run.finished',
    task_id: task.id,
    run_id: run.id,
    agent_id: input.agent.id,
    payload: {
      status: estadoRun,
      outcome: result?.outcome ?? null,
      summary: result?.summary ?? null,
      error: fallo,
      cost_usd: outcome.costUsd,
      denied_tools: input.denegaciones,
    },
  });

  db.prepare("UPDATE tasks SET active_run_id = NULL, updated_at = ? WHERE id = ? AND active_run_id = ?").run(
    now(),
    task.id,
    run.id,
  );

  decideTaskStatus(db, bus, { ...input, estadoRun, fallo });
}

function decideTaskStatus(
  db: Db,
  bus: EventBus,
  input: FinishRunInput & { estadoRun: string; fallo: string | null },
): void {
  const { task, result, maxAttempts, estadoRun } = input;
  const actual = requireTask(db, task.id);
  if (actual.status !== 'in_progress') return;

  // Un fallo de credenciales o de cuota no gasta intentos: no es culpa del trabajo.
  if (input.outcome.terminalReason === 'api_error') {
    setStatus(db, bus, task.id, 'blocked', 'El motor no pudo hablar con la API: credenciales, cuota o red.');
    return;
  }

  if (estadoRun !== 'succeeded' || !result) {
    if (actual.attempts >= maxAttempts) {
      setStatus(
        db,
        bus,
        task.id,
        'blocked',
        `La tarea falló ${actual.attempts} veces seguidas. Último motivo: ${input.fallo ?? 'desconocido'}`,
      );
    } else {
      setStatus(db, bus, task.id, 'ready', input.fallo ?? 'la ejecución no terminó bien');
    }
    return;
  }

  switch (result.outcome) {
    case 'blocked':
      setStatus(db, bus, task.id, 'blocked', result.summary);
      return;

    case 'failed':
      if (actual.attempts >= maxAttempts) {
        setStatus(db, bus, task.id, 'blocked', `La tarea falló ${actual.attempts} veces. ${result.summary}`);
      } else {
        setStatus(db, bus, task.id, 'ready', result.summary);
      }
      return;

    case 'partial':
      setStatus(db, bus, task.id, 'ready', 'el agente avanzó sin terminar');
      return;

    case 'completed':
      // Una tarea que ha publicado código espera revisión. Las demás quedan hechas.
      if (ESCRIBEN_CODIGO.has(task.kind) && requireTask(db, task.id).head_commit) {
        setStatus(db, bus, task.id, 'in_review', 'incremento publicado, pendiente de revisión');
      } else {
        setStatus(db, bus, task.id, 'done', result.summary);
      }
      return;
  }
}

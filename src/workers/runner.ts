import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Db } from '../core/db.js';
import { EventBus, appendEvent } from '../core/events.js';
import { buildAssignment, renderAssignment } from '../core/assignment.js';
import { agentTools, protectedPaths, requireProject } from '../core/projects.js';
import { instructionsFor } from '../core/roles.js';
import { ejecutarVerificacion } from '../core/integration.js';
import { ficherosProtegidos, motivoDeBloqueo } from '../core/protected-paths.js';
import { cerrarTrasLimpieza, openFindings, publishIncrement } from '../core/review.js';
import { addNotice, markNoticesDelivered, requireTask, setStatus } from '../core/tasks.js';
import { isRunCurrent, recordStaleResult, releaseLease } from '../core/leases.js';
import { helpRequestToTask, markDelivered, sendAgentMessage } from '../core/agent-messages.js';
import { orchestratorAgent, postChatMessage } from '../core/orchestrator.js';
import { newId, now } from '../shared/ids.js';
import {
  AGENT_RESULT_JSON_SCHEMA,
  agentResultSchema,
  type Agent,
  type AgentResult,
  type Project,
  type Run,
  type Task,
} from '../shared/types.js';
import type { Engine, EngineRunOutcome } from '../engines/types.js';
import {
  changedFiles,
  discardChanges,
  ensureDetachedWorktree,
  ensureWorktree,
  git,
  isGitRepo,
  lastCommit,
  removeWorktree,
  resolveCommit,
  uncommittedFiles,
} from './git.js';

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
const ESCRIBEN_CODIGO = new Set(['build', 'fix', 'refactor']);

/** Tipos de tarea que pueden pedir apoyo a otro rol. */
const PIDEN_APOYO = new Set(['build', 'fix']);

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
  /**
   * Verdadero cuando lo ocurrido necesita que el orquestador tome un turno: el agente ha
   * hecho una pregunta, o la tarea ha quedado bloqueada (documento 06, apartado 6.1).
   */
  needsOrchestrator: boolean;
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
  markDelivered(db, agent.id);

  const handle = engine.start(
    {
      prompt,
      cwd: workspace.path,
      allowedTools: agentTools(agent),
      timeoutMs: project.run_timeout_ms,
      model: agent.model,
      resultSchema: AGENT_RESULT_JSON_SCHEMA,
      systemPromptAppend: instructionsFor(agent.role),
      sessionId: run.engine_session_id ?? undefined,
      resumeSessionId: previousSessionId(db, task.id),
      // Dentro de su worktree el agente trabaja sin pedir permiso a cada paso. Lo que
      // realmente lo limita es la lista de herramientas y el aislamiento del worktree,
      // no el prompt de permisos (decisión D26).
      permissionMode: 'bypassPermissions',
      usePersonalConfig: project.use_personal_config === 1,
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

  // Un worker que se dio por perdido puede volver en sí y devolver su resultado tarde. Ese
  // resultado no puede pisar el trabajo de quien tomó la tarea después (decisión D31).
  if (!isRunCurrent(db, run.id)) {
    const { result: tardio } = parseResult(outcome.resultText);
    recordStaleResult(db, bus, run.id, tardio?.summary ?? null);
    await recogerWorkspace(project.repo_path, task, workspace);
    return {
      outcome,
      result: null,
      parseError: 'La ejecución ya había sido sustituida.',
      incrementId: null,
      needsOrchestrator: false,
    };
  }
  const denegaciones = saveApprovals(db, bus, task, run, outcome);

  const { result: declarado, parseError } = parseResult(outcome.resultText);

  // Lo que el agente diga sobre la verificación no se da por bueno: se ejecuta y se mide.
  const result = await conVerificacionMedida(db, bus, {
    task,
    run,
    project,
    workspacePath: workspace.path,
    result: declarado,
  });

  const incrementId = await recordWork(db, bus, {
    task,
    run,
    project_repo: project.repo_path,
    workspacePath: workspace.path,
    baseCommit: workspace.baseCommit,
    protectedPaths: protectedPaths(project),
    result,
  });

  const apoyos = crearApoyos(db, bus, task, agent, result);

  finishRun(db, bus, {
    task, agent, run, outcome, result, parseError, denegaciones,
    maxAttempts: project.max_task_attempts, apoyos,
  });

  await recogerWorkspace(project.repo_path, task, workspace);

  const preguntas = elevarPreguntas(db, bus, task, agent, result);
  const bloqueada = requireTask(db, task.id).status === 'blocked';

  // Una limpieza que se bloquea no deja esperando al trabajo que limpiaba.
  if (bloqueada && task.kind === 'refactor') await abandonarLimpieza(db, bus, task.id);

  return { outcome, result, parseError, incrementId, needsOrchestrator: preguntas > 0 || bloqueada };
}

// ---------------------------------------------------------------------------
// Espacio de trabajo
// ---------------------------------------------------------------------------

interface Workspace {
  path: string;
  baseCommit: string;
  /** Cómo se deja el directorio al terminar la ejecución. */
  alTerminar: 'conservar' | 'descartar_cambios' | 'eliminar';
}

/**
 * Prepara el directorio donde va a trabajar el motor.
 *
 * Ningún agente trabaja en el directorio del creador (decisión D45). El motor se lanza
 * con Bash y sin pedir permiso, y una instrucción de «no modifiques nada» es una petición,
 * no una garantía. Cada tipo de tarea tiene su sitio:
 *
 * - Las que escriben código: un worktree con su rama. Una limpieza sigue en el worktree
 *   del trabajo que limpia.
 * - Una revisión: el worktree del trabajo que revisa, que está parado mientras tanto. Al
 *   terminar se descarta lo que haya dejado.
 * - Una investigación: un worktree sin rama sobre la rama principal, que se elimina al
 *   terminar.
 */
async function prepareWorkspace(
  db: Db,
  task: Task,
  repoPath: string,
  mainBranch: string,
  installCommand: string | null,
): Promise<Workspace> {
  if (task.kind === 'review') return prepararRevision(db, task, repoPath);

  if (!ESCRIBEN_CODIGO.has(task.kind)) {
    // Una carpeta que no es un repositorio no admite worktrees. Solo se puede leer.
    if (!(await isGitRepo(repoPath))) {
      return { path: repoPath, baseCommit: '', alTerminar: 'conservar' };
    }

    const commit = await resolveCommit(repoPath, mainBranch).catch(() => resolveCommit(repoPath, 'HEAD'));
    const ruta = join(workspacesRoot(), task.id);
    const { created } = await ensureDetachedWorktree(repoPath, ruta, commit);
    if (created && installCommand) {
      await ejecutarComando(installCommand, ruta).catch(() => undefined);
    }
    return { path: ruta, baseCommit: commit, alTerminar: 'eliminar' };
  }

  // Una limpieza continúa en la rama y el worktree del trabajo que limpia, no en uno nuevo.
  const rama = task.branch ?? branchForTask(task.parent_task_id ?? task.id);
  const ruta = task.workspace_path ?? join(workspacesRoot(), task.parent_task_id ?? task.id);

  const { created, baseCommit } = await ensureWorktree(repoPath, ruta, rama, mainBranch);

  if (created && installCommand) {
    await ejecutarComando(installCommand, ruta).catch(() => undefined);
  }

  db.prepare(
    'UPDATE tasks SET workspace_path = ?, branch = ?, base_commit = COALESCE(base_commit, ?), updated_at = ? WHERE id = ?',
  ).run(ruta, rama, baseCommit, now(), task.id);

  return { path: ruta, baseCommit: task.base_commit ?? baseCommit, alTerminar: 'conservar' };
}

/**
 * El reviewer trabaja en el worktree del trabajo que revisa: ahí están la rama, las
 * dependencias instaladas y el commit exacto. Si ese worktree ya no existe, se le prepara
 * uno sin rama sobre el commit revisado.
 */
async function prepararRevision(db: Db, task: Task, repoPath: string): Promise<Workspace> {
  const revisada = task.parent_task_id ? requireTask(db, task.parent_task_id) : null;
  const commit = task.base_commit ?? revisada?.head_commit ?? (await resolveCommit(repoPath, 'HEAD'));

  if (revisada?.workspace_path && (await isGitRepo(revisada.workspace_path))) {
    db.prepare('UPDATE tasks SET workspace_path = ?, updated_at = ? WHERE id = ?').run(
      revisada.workspace_path,
      now(),
      task.id,
    );
    return { path: revisada.workspace_path, baseCommit: commit, alTerminar: 'descartar_cambios' };
  }

  const ruta = join(workspacesRoot(), task.id);
  await ensureDetachedWorktree(repoPath, ruta, commit);
  return { path: ruta, baseCommit: commit, alTerminar: 'eliminar' };
}

/** Deja el directorio de trabajo como corresponde a su tipo de tarea. */
async function recogerWorkspace(repoPath: string, task: Task, workspace: Workspace): Promise<void> {
  try {
    if (workspace.alTerminar === 'descartar_cambios') {
      await discardChanges(workspace.path);
    } else if (workspace.alTerminar === 'eliminar') {
      await removeWorktree(repoPath, workspace.path);
    }
  } catch {
    // No poder recoger el directorio no invalida el resultado de la ejecución. Quedará un
    // worktree de más, que `git worktree prune` limpia en la siguiente integración.
  }
  void task;
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
// Verificación medida por el sistema
// ---------------------------------------------------------------------------

interface VerificacionInput {
  task: Task;
  run: Run;
  project: Project;
  workspacePath: string;
  result: AgentResult | null;
}

/**
 * Ejecuta el comando de verificación del proyecto y sustituye por el resultado medido lo
 * que el agente declaró en su resultado.
 *
 * El campo `verification` es lo que decide si un trabajo se puede saltar la revisión. Si
 * saliera de la palabra del agente, bastaría con que dijera que las pruebas pasan, sin
 * haberlas ejecutado, para que su código quedara terminado sin que nadie lo mirase.
 * Ejecutarlo aquí convierte esa afirmación en un hecho comprobado.
 */
async function conVerificacionMedida(
  db: Db,
  bus: EventBus,
  input: VerificacionInput,
): Promise<AgentResult | null> {
  const { task, run, project, result } = input;

  if (!result) return result;
  // Una tarea que no escribe código no deja nada que verificar. Una revisión, además,
  // trabaja sobre el repositorio principal, donde el comando no diría nada de su trabajo.
  if (!ESCRIBEN_CODIGO.has(task.kind)) return result;
  if (!project.verify_command) return result;

  const medida = await ejecutarVerificacion(project.verify_command, input.workspacePath);

  const declarada = result.verification;
  const declaroAlgoFalso = declarada?.ran === true && declarada.passed === true && !medida.passed;

  appendEvent(db, bus, {
    project_id: task.project_id,
    type: 'run.progress',
    task_id: task.id,
    run_id: run.id,
    payload: {
      kind: 'notice',
      text: declaroAlgoFalso
        ? `El agente dijo que la verificación pasaba. Ejecutada por el sistema con ${medida.command}, no pasa.`
        : `Verificación ejecutada por el sistema con ${medida.command}: ${medida.passed ? 'pasa' : 'no pasa'}.`,
      is_error: !medida.passed,
    },
  });

  // El aviso se entrega en el siguiente intento de esta tarea, que es cuando el agente
  // puede hacer algo con él (decisión D12).
  if (declaroAlgoFalso) {
    addNotice(
      db,
      task.id,
      'system',
      'En tu intento anterior dijiste que la verificación del proyecto pasaba. El sistema la ejecutó y no pasa. Comprueba el resultado real antes de terminar.',
    );
  }

  return {
    ...result,
    verification: {
      ran: true,
      command: medida.command,
      passed: medida.passed,
      output_excerpt: medida.output.slice(-2000),
    },
  };
}

// ---------------------------------------------------------------------------
// Guardado
// ---------------------------------------------------------------------------

/**
 * Guarda el consumo de la suscripción que el motor informa al terminar una ejecución.
 *
 * Es la única forma de saber la cuota: el motor la publica dentro de la ejecución, y no
 * hay forma de preguntarla aparte. Por eso la llaman todos los sitios que ejecutan un
 * motor, incluido el turno del orquestador. Si solo la llamara el runner, la cifra se
 * quedaría vieja en cuanto pasara un rato sin tareas.
 */
export function saveUsage(db: Db, bus: EventBus, engine: string, outcome: EngineRunOutcome): void {
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
  /** Patrones de ruta que este proyecto no deja tocar a nadie. */
  protectedPaths: string[];
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

      // El trabajo de una revisión es dar el veredicto. Una vez dado, la revisión está
      // hecha, aunque el agente diga que avanzó sin terminar: no hay nada más que revisar
      // de ese incremento (decisión D37).
      if (result.outcome === 'completed' || result.outcome === 'partial') {
        setStatus(
          db,
          bus,
          task.id,
          'done',
          (result.findings?.length ?? 0) > 0
            ? `revisión con ${result.findings!.length} hallazgos`
            : 'revisión sin hallazgos',
        );
      }
    }
    return null;
  }

  if (!ESCRIBEN_CODIGO.has(task.kind)) return null;

  // Si el agente dejó cambios sin confirmar, el worker hace el commit por él. Perder el
  // trabajo de una ejecución entera porque falló el último paso no tiene sentido.
  await commitPendiente(input.workspacePath, result.summary, task.title);

  // Se toma el commit real del worktree, no el que diga el agente: si se equivoca de
  // identificador, el incremento apuntaría a algo que no existe.
  const commit = await lastCommit(input.workspacePath);
  if (!commit || commit.sha === input.baseCommit) return null;

  const ficheros = await changedFiles(input.workspacePath, input.baseCommit, commit.sha).catch(() => []);

  // El agente tiene la lista de ficheros protegidos en su encargo, pero una instrucción se
  // puede desatender. Un cambio que los toca no se publica y su tarea queda bloqueada, así
  // que no puede llegar a integrarse sin que lo decida una persona.
  const protegidos = ficherosProtegidos(ficheros, input.protectedPaths);
  if (protegidos.length > 0) {
    const motivo = motivoDeBloqueo(protegidos);

    appendEvent(db, bus, {
      project_id: task.project_id,
      type: 'run.progress',
      task_id: task.id,
      run_id: run.id,
      payload: { kind: 'notice', text: motivo, is_error: true },
    });

    addNotice(
      db,
      task.id,
      'system',
      `${motivo} Deshaz los cambios en esos ficheros antes de volver a publicar. Si de verdad hacen falta, termina con outcome igual a blocked y explica por qué.`,
    );

    setStatus(db, bus, task.id, 'blocked', motivo);
    return null;
  }

  const publicado = publishIncrement(db, bus, {
    task_id: task.id,
    run_id: run.id,
    commit_sha: commit.sha,
    branch: task.branch ?? branchForTask(task.id),
    message: commit.message,
    files: ficheros,
    // Con el resultado del agente, publishIncrement puede decidir si hace falta revisión.
    result,
  });

  return publicado.increment.id;
}

/**
 * Confirma lo que haya quedado sin confirmar en el worktree.
 *
 * El mensaje sale del resumen del agente, recortado a una línea, para que el historial se
 * lea bien.
 */
async function commitPendiente(worktreePath: string, resumen: string, titulo: string): Promise<void> {
  const sinConfirmar = await uncommittedFiles(worktreePath).catch(() => []);
  if (sinConfirmar.length === 0) return;

  const primeraLinea = resumen.split('\n')[0]?.trim() ?? '';
  const mensaje = (primeraLinea.length > 8 ? primeraLinea : titulo).slice(0, 100);

  await git(worktreePath, ['add', '-A']);
  await git(worktreePath, [
    '-c', 'user.email=agente@codehive.local',
    '-c', 'user.name=Code Hive Factory',
    'commit', '-m', mensaje,
  ]);
}

/**
 * Convierte en tareas las peticiones de apoyo que el agente dejó en su resultado.
 *
 * Pedir ayuda no es que otro haga tu trabajo sin dejar rastro: cada petición produce una
 * tarea con su propio responsable, y la tarea que la pidió espera a que se resuelva
 * (documento 06, apartado 6.2).
 */
function crearApoyos(
  db: Db,
  bus: EventBus,
  task: Task,
  agent: Agent,
  result: AgentResult | null,
): string[] {
  if (!result?.needs || result.needs.length === 0) return [];

  // Solo quien construye pide apoyo. El investigador responde con lo que encuentra o dice
  // que no se puede saber; el reviewer revisa lo que hay. Si el investigador pudiera pedir
  // apoyo, cada respuesta abriría otra pregunta y la cadena no terminaría nunca (D36).
  if (!PIDEN_APOYO.has(task.kind)) return [];

  // Una tarea de apoyo no pide más apoyo. Un nivel es suficiente para desbloquear a quien
  // preguntó, y más niveles solo alejan el trabajo del objetivo.
  if (task.parent_task_id) {
    const padre = db.prepare('SELECT kind FROM tasks WHERE id = ?').get(task.parent_task_id) as
      | { kind: string }
      | undefined;
    if (padre?.kind === 'research') return [];
  }

  // Una tarea que sigue esperando un apoyo no pide otro: sin esta comprobación, cada
  // intento crearía una tarea de apoyo más para la misma pregunta.
  const yaEsperando = db
    .prepare(
      `SELECT COUNT(*) AS n FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_id
       WHERE d.task_id = ? AND t.status NOT IN ('done','cancelled')`,
    )
    .get(task.id) as { n: number };
  if (yaEsperando.n > 0) return [];

  const creadas: string[] = [];
  for (const peticion of result.needs.slice(0, 3)) {
    const apoyo = helpRequestToTask(db, bus, {
      project_id: task.project_id,
      from_agent_id: agent.id,
      to_role: 'researcher',
      body: peticion,
      task_id: task.id,
    });

    db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run(
      task.id,
      apoyo.id,
    );
    creadas.push(apoyo.id);
  }
  return creadas;
}

/**
 * Lleva al orquestador las preguntas que el agente dejó en su resultado.
 *
 * Una pregunta que se queda en la base de datos sin que nadie la lea es trabajo parado
 * sin que se sepa por qué. Cada una se guarda como mensaje dirigido al orquestador, que
 * la ve en su siguiente turno, y se publica en el chat para que el creador también la vea.
 *
 * Devuelve cuántas preguntas se han elevado.
 */
function elevarPreguntas(db: Db, bus: EventBus, task: Task, agent: Agent, result: AgentResult | null): number {
  const preguntas = (result?.questions ?? []).map((p) => p.trim()).filter(Boolean);
  if (preguntas.length === 0) return 0;

  const orquestador = orchestratorAgent(db, task.project_id);
  for (const pregunta of preguntas) {
    sendAgentMessage(db, bus, {
      project_id: task.project_id,
      from_agent_id: agent.id,
      to_agent_id: orquestador?.id ?? null,
      kind: 'question',
      body: pregunta,
      task_id: task.id,
    });
  }

  postChatMessage(
    db,
    bus,
    task.project_id,
    agent.role,
    `Sobre «${task.title}»:\n${preguntas.map((p) => `- ${p}`).join('\n')}`,
    task.id,
  );

  return preguntas.length;
}

/**
 * Cierra una limpieza que no va a terminar: bloqueada o cancelada.
 *
 * La rama vuelve al commit que el reviewer aprobó, para que lo que el refactorer dejara a
 * medias no entre en la integración, y el trabajo que esperaba a la limpieza queda hecho
 * con ese commit.
 */
export async function abandonarLimpieza(db: Db, bus: EventBus, refactorTaskId: string): Promise<void> {
  const refactor = requireTask(db, refactorTaskId);
  if (refactor.kind !== 'refactor' || !refactor.parent_task_id) return;

  const padre = requireTask(db, refactor.parent_task_id);
  if (padre.head_commit && padre.workspace_path && (await isGitRepo(padre.workspace_path))) {
    await git(padre.workspace_path, ['reset', '--hard', '--quiet', padre.head_commit]).catch(() => undefined);
    await git(padre.workspace_path, ['clean', '-fd', '--quiet']).catch(() => undefined);
  }

  cerrarTrasLimpieza(db, bus, refactorTaskId);
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
  apoyos: string[];
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
  releaseLease(db, task.id);

  decideTaskStatus(db, bus, { ...input, estadoRun, fallo });
}

/** Si esta tarea tiene una revisión pendiente de terminar. */
function tieneRevisionAbierta(db: Db, taskId: string): boolean {
  const fila = db
    .prepare(
      `SELECT 1 AS hay FROM tasks
       WHERE parent_task_id = ? AND kind = 'review' AND status NOT IN ('done','cancelled')
       LIMIT 1`,
    )
    .get(taskId) as { hay: number } | undefined;
  return fila !== undefined;
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
      if (input.apoyos.length > 0) {
        setStatus(db, bus, task.id, 'pending', `espera el apoyo que ha pedido: ${result.summary}`);
        return;
      }
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
      // Si pidió apoyo, espera a que llegue en vez de reintentar a ciegas.
      if (input.apoyos.length > 0) {
        setStatus(db, bus, task.id, 'pending', `espera el apoyo que ha pedido (${input.apoyos.length} tareas)`);
        return;
      }
      // Avanzar sin terminar también gasta intentos: sin ese límite, un agente que nunca
      // cierra la tarea la reintenta indefinidamente.
      if (actual.attempts >= maxAttempts) {
        setStatus(
          db, bus, task.id, 'blocked',
          `La tarea avanzó sin terminar en ${actual.attempts} intentos. Último resumen: ${result.summary}`,
        );
      } else {
        setStatus(db, bus, task.id, 'ready', 'el agente avanzó sin terminar');
      }
      return;

    case 'completed':
      // Una tarea que ha publicado código espera revisión, pero solo si se le ha abierto
      // una. En modo normal el orquestador puede haber marcado que no hace falta, y
      // entonces la tarea queda hecha en cuanto publica.
      if (
        ESCRIBEN_CODIGO.has(task.kind) &&
        requireTask(db, task.id).head_commit &&
        tieneRevisionAbierta(db, task.id)
      ) {
        setStatus(db, bus, task.id, 'in_review', 'incremento publicado, pendiente de revisión');
      } else {
        setStatus(db, bus, task.id, 'done', result.summary);
        // Una limpieza que termina sin dejar nada que revisar cierra también el trabajo
        // que la esperaba.
        if (task.kind === 'refactor') cerrarTrasLimpieza(db, bus, task.id);
      }
      return;

    default:
      setStatus(db, bus, task.id, 'ready', 'resultado no reconocido');
      return;
  }
}

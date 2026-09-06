import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Db } from './db.js';
import { EventBus, appendEvent } from './events.js';
import { requireProject } from './projects.js';
import { openFindings, readyToIntegrate } from './review.js';
import { RuleError, addNotice, requireTask, setStatus } from './tasks.js';
import { mergeBranch, removeWorktree, resolveCommit, undoLastMerge } from '../workers/git.js';
import { createTask } from './tasks.js';

const execFileAsync = promisify(execFile);

export interface IntegrationResult {
  integrated: boolean;
  reason: string;
  merge_commit?: string;
  conflicts?: string[];
  verification?: { command: string; passed: boolean; output: string };
  fix_task_id?: string;
}

/**
 * Fusiona la rama de una tarea en la principal y comprueba que el resultado sigue
 * funcionando.
 *
 * Que el reviewer haya aprobado la rama aislada no garantiza que la fusión funcione: los
 * cambios de la rama principal pueden haber roto el comportamiento revisado. Por eso las
 * verificaciones se ejecutan después de fusionar, y si fallan se deshace la fusión y se
 * abre una corrección (documento 07, apartado 7.7).
 */
export async function integrateTask(db: Db, bus: EventBus, taskId: string): Promise<IntegrationResult> {
  const task = requireTask(db, taskId);
  const project = requireProject(db, task.project_id);

  const listo = readyToIntegrate(db, taskId);
  if (!listo.ready) {
    return { integrated: false, reason: listo.reason ?? 'La tarea no está lista para integrar.' };
  }
  if (!task.branch) {
    return { integrated: false, reason: 'La tarea no tiene rama asociada.' };
  }

  const commitAnterior = await resolveCommit(project.repo_path, project.main_branch);

  const fusion = await mergeBranch(
    project.repo_path,
    project.main_branch,
    task.branch,
    `Integra: ${task.title}`,
  );

  if (!fusion.merged) {
    const motivo = fusion.conflicts.length
      ? `Conflicto al fusionar en ${fusion.conflicts.join(', ')}.`
      : `No se pudo fusionar: ${fusion.message}`;

    setStatus(db, bus, taskId, 'ready', motivo);
    addNotice(db, taskId, 'system', `${motivo} Resuelve el conflicto en tu rama y vuelve a publicar.`);

    appendEvent(db, bus, {
      project_id: task.project_id,
      type: 'integration.completed',
      task_id: taskId,
      payload: { integrated: false, reason: motivo, conflicts: fusion.conflicts },
    });

    return { integrated: false, reason: motivo, conflicts: fusion.conflicts };
  }

  const mergeCommit = await resolveCommit(project.repo_path, project.main_branch);

  if (!project.verify_command) {
    return finalizarIntegracion(db, bus, task.id, project.repo_path, task.branch, mergeCommit, {
      integrated: true,
      reason: 'Fusión completada. El proyecto no tiene comando de verificación configurado.',
      merge_commit: mergeCommit,
    });
  }

  const verificacion = await ejecutarVerificacion(project.verify_command, project.repo_path);

  if (verificacion.passed) {
    return finalizarIntegracion(db, bus, task.id, project.repo_path, task.branch, mergeCommit, {
      integrated: true,
      reason: 'Fusión completada y verificaciones superadas.',
      merge_commit: mergeCommit,
      verification: verificacion,
    });
  }

  // Las verificaciones fallan: la rama principal vuelve a como estaba antes de fusionar.
  await undoLastMerge(project.repo_path, commitAnterior);

  const correccion = createTask(db, bus, {
    project_id: task.project_id,
    parent_task_id: task.id,
    kind: 'fix',
    title: `Corregir: la integración de "${task.title}" rompe las verificaciones`,
    goal: `Al fusionar la rama ${task.branch} en ${project.main_branch}, el comando ${project.verify_command} falla.`,
    scope: 'Corregir solo lo que hace fallar la verificación tras la fusión.',
    acceptance: `El comando ${project.verify_command} pasa con la rama fusionada.`,
    required_role: task.required_role,
    priority: 5,
    created_by: 'system',
    branch: task.branch,
    base_commit: task.head_commit,
  });

  setStatus(db, bus, taskId, 'ready', 'la integración rompió las verificaciones');
  addNotice(db, taskId, 'system', 'La fusión pasó pero las verificaciones fallaron. La fusión se ha deshecho.');

  appendEvent(db, bus, {
    project_id: task.project_id,
    type: 'integration.completed',
    task_id: taskId,
    payload: {
      integrated: false,
      reason: 'las verificaciones fallaron tras fusionar',
      reverted_to: commitAnterior,
      fix_task_id: correccion.id,
      output: verificacion.output.slice(-2000),
    },
  });

  return {
    integrated: false,
    reason: 'Las verificaciones fallaron tras fusionar. La fusión se ha deshecho.',
    verification: verificacion,
    fix_task_id: correccion.id,
  };
}

/** Cierra una integración correcta: libera el espacio de trabajo y avisa. */
async function finalizarIntegracion(
  db: Db,
  bus: EventBus,
  taskId: string,
  repoPath: string,
  branch: string,
  mergeCommit: string,
  resultado: IntegrationResult,
): Promise<IntegrationResult> {
  const task = requireTask(db, taskId);

  if (task.workspace_path) {
    await removeWorktree(repoPath, task.workspace_path, { deleteBranch: branch }).catch(() => undefined);
    db.prepare('UPDATE tasks SET workspace_path = NULL WHERE id = ?').run(taskId);
  }

  db.prepare(
    "UPDATE resource_locks SET released_at = datetime('now') WHERE task_id = ? AND released_at IS NULL",
  ).run(taskId);

  appendEvent(db, bus, {
    project_id: task.project_id,
    type: 'integration.completed',
    task_id: taskId,
    payload: { integrated: true, merge_commit: mergeCommit, branch, reason: resultado.reason },
  });

  return resultado;
}

/** Ejecuta el comando de verificación del proyecto y recoge su salida. */
export async function ejecutarVerificacion(
  comando: string,
  cwd: string,
): Promise<{ command: string; passed: boolean; output: string }> {
  const partes = comando.split(' ').filter(Boolean);
  const programa = partes[0];
  if (!programa) return { command: comando, passed: false, output: 'El comando de verificación está vacío.' };

  try {
    const { stdout, stderr } = await execFileAsync(programa, partes.slice(1), {
      cwd,
      timeout: 900_000,
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    return { command: comando, passed: true, output: (stdout + stderr).slice(-8000) };
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string; message?: string };
    return {
      command: comando,
      passed: false,
      output: ((error.stdout ?? '') + (error.stderr ?? '') + (error.message ?? '')).slice(-8000),
    };
  }
}

/** Tareas que el creador puede integrar ahora mismo. */
export function integrableTasks(db: Db, projectId: string): Array<{ id: string; title: string; branch: string; commit: string }> {
  const candidatas = db
    .prepare(
      `SELECT id, title, branch, head_commit FROM tasks
       WHERE project_id = ? AND status = 'done' AND head_commit IS NOT NULL AND branch IS NOT NULL`,
    )
    .all(projectId) as Array<{ id: string; title: string; branch: string; head_commit: string }>;

  return candidatas
    .filter((t) => readyToIntegrate(db, t.id).ready)
    .map((t) => ({ id: t.id, title: t.title, branch: t.branch, commit: t.head_commit }));
}

/** Usado por las pruebas y por la API para dar un motivo claro cuando no se puede integrar. */
export function assertIntegrable(db: Db, taskId: string): void {
  const listo = readyToIntegrate(db, taskId);
  if (!listo.ready) throw new RuleError(listo.reason ?? 'La tarea no se puede integrar.');
}

export { openFindings };

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Db } from './db.js';
import { EventBus, appendEvent } from './events.js';
import { requireProject } from './projects.js';
import { openFindings, openSystemFinding, readyToIntegrate } from './review.js';
import { RuleError, addNotice, requireTask, setStatus } from './tasks.js';
import {
  currentBranch,
  isClean,
  mergeBranch,
  removeWorktree,
  resolveCommit,
  undoLastMerge,
} from '../workers/git.js';
import { now } from '../shared/ids.js';

const execFileAsync = promisify(execFile);

export interface IntegrationResult {
  integrated: boolean;
  reason: string;
  merge_commit?: string;
  conflicts?: string[];
  verification?: { command: string; passed: boolean; output: string };
  finding_id?: string;
}

/**
 * Fusiona la rama de una tarea en la principal y comprueba que el resultado sigue
 * funcionando.
 *
 * Que el reviewer haya aprobado la rama aislada no garantiza que la fusión funcione: los
 * cambios de la rama principal pueden haber roto el comportamiento revisado. Por eso las
 * verificaciones se ejecutan después de fusionar, y si fallan se deshace la fusión y se
 * abre un hallazgo que devuelve la tarea a la cola (documento 07, apartado 7.8).
 *
 * La fusión ocurre en el repositorio del creador, así que antes se comprueba que está en
 * la rama principal y sin cambios sin confirmar. Deshacer una fusión con `reset --hard`
 * encima de cambios del creador los borraría, y eso no puede pasar (decisión D45).
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

  const impedimento = await impedimentoParaFusionar(project.repo_path, project.main_branch, task.branch, task.head_commit);
  if (impedimento) return { integrated: false, reason: impedimento };

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
  // El repositorio estaba limpio antes de empezar, así que el reset solo deshace la fusión.
  await undoLastMerge(project.repo_path, commitAnterior);

  // El hallazgo devuelve la propia tarea a la cola, sobre su misma rama, con la condición
  // de resolución delante. No se crea ninguna tarea aparte (decisión D44).
  const hallazgo = openSystemFinding(db, bus, {
    task_id: task.id,
    title: 'La integración rompe las verificaciones',
    detail:
      `Al fusionar la rama ${task.branch} en ${project.main_branch}, el comando ${project.verify_command} falla. ` +
      `La fusión se ha deshecho. Salida:\n${verificacion.output.slice(-2000)}`,
    resolution: `El comando ${project.verify_command} pasa con la rama fusionada sobre ${project.main_branch}.`,
  });

  appendEvent(db, bus, {
    project_id: task.project_id,
    type: 'integration.completed',
    task_id: taskId,
    payload: {
      integrated: false,
      reason: 'las verificaciones fallaron tras fusionar',
      reverted_to: commitAnterior,
      finding_id: hallazgo.id,
      output: verificacion.output.slice(-2000),
    },
  });

  return {
    integrated: false,
    reason: 'Las verificaciones fallaron tras fusionar. La fusión se ha deshecho.',
    verification: verificacion,
    finding_id: hallazgo.id,
  };
}

/**
 * Motivo por el que no se puede fusionar ahora mismo, o null si todo está en orden.
 *
 * Ninguna de estas comprobaciones cambia nada: el creador arregla lo que se le dice y
 * vuelve a pulsar integrar.
 */
async function impedimentoParaFusionar(
  repoPath: string,
  mainBranch: string,
  branch: string,
  headCommit: string | null,
): Promise<string | null> {
  const rama = await currentBranch(repoPath);
  if (rama !== mainBranch) {
    return `El repositorio está en la rama ${rama}. Cambia a ${mainBranch} antes de integrar.`;
  }

  if (!(await isClean(repoPath))) {
    return 'El repositorio tiene cambios sin confirmar. Guárdalos o descártalos antes de integrar: la fusión se hace encima de tu copia de trabajo.';
  }

  // Lo que se fusiona es la rama entera, así que su punta tiene que ser exactamente el
  // commit que el reviewer aprobó. Un commit de más es trabajo que nadie ha revisado.
  const punta = await resolveCommit(repoPath, branch).catch(() => null);
  if (!punta) return `La rama ${branch} ya no existe.`;
  if (headCommit && punta !== headCommit) {
    return `La rama ${branch} tiene commits que no han pasado por revisión (punta ${punta.slice(0, 8)}, aprobado ${headCommit.slice(0, 8)}).`;
  }

  return null;
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

  // Las revisiones y la limpieza de esta tarea trabajaron en el mismo worktree, que ya no
  // existe. Se les quita la ruta para que nadie intente volver a él.
  db.prepare('UPDATE tasks SET workspace_path = NULL WHERE parent_task_id = ?').run(taskId);

  db.prepare(
    "UPDATE resource_locks SET released_at = datetime('now') WHERE task_id = ? AND released_at IS NULL",
  ).run(taskId);

  // Queda marcada como integrada. El encargo del orquestador deja de mandarle el resumen
  // de una tarea ya fusionada: lo que hizo ya está en la rama principal.
  db.prepare('UPDATE tasks SET integrated_at = ?, updated_at = ? WHERE id = ?').run(
    now(),
    now(),
    taskId,
  );

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
       WHERE project_id = ? AND status = 'done' AND head_commit IS NOT NULL AND branch IS NOT NULL
         AND integrated_at IS NULL`,
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

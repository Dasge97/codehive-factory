import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(message: string, readonly stderr: string = '') {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Ejecuta una orden de git. Sin shell, para que las rutas y los mensajes con espacios o
 * comillas lleguen enteros.
 */
export async function git(cwd: string, args: string[], opciones: { timeoutMs?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: opciones.timeoutMs ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (e) {
    const error = e as { stderr?: string; message?: string; killed?: boolean };

    // Si se acabó el tiempo, el motivo es ese y no lo que git hubiera escrito por el
    // camino. Sin esta distinción, un `git add` que tarda demasiado se presenta como un
    // muro de avisos de fin de línea y no se entiende qué ha pasado.
    if (error.killed) {
      throw new GitError(
        `git ${args.join(' ')} se ha pasado del tiempo máximo en ${cwd}.`,
        error.stderr ?? '',
      );
    }

    const motivo = error.stderr?.trim() || error.message || 'error desconocido';
    throw new GitError(`git ${args.join(' ')} falló en ${cwd}: ${recortarSalida(motivo)}`, error.stderr ?? '');
  }
}

/**
 * Cuánto de la salida de git cabe en un mensaje de error.
 *
 * Un comando sobre miles de ficheros escribe un aviso por cada uno. Enseñarlos todos tapa
 * el motivo del fallo, que casi siempre está en las primeras líneas.
 */
const LARGO_DEL_ERROR = 400;

function recortarSalida(texto: string): string {
  const limpio = texto.replace(/\s+/g, ' ').trim();
  return limpio.length <= LARGO_DEL_ERROR ? limpio : `${limpio.slice(0, LARGO_DEL_ERROR)}…`;
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await git(path, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/** Nombre de la rama en la que está el repositorio ahora mismo. */
export async function ramaActual(path: string): Promise<string> {
  return git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/** Identificador del commit al que apunta una referencia. */
export async function resolveCommit(repoPath: string, ref: string): Promise<string> {
  return git(repoPath, ['rev-parse', ref]);
}

export async function currentBranch(repoPath: string): Promise<string> {
  return git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepara el espacio de trabajo aislado de una tarea (decisión D09).
 *
 * Si el worktree ya existe se reutiliza, que es lo que permite reintentar una tarea sin
 * perder lo que el intento anterior dejó a medias. Si la rama ya existe, el worktree se
 * engancha a ella en lugar de crearla.
 */
export async function ensureWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
): Promise<{ created: boolean; baseCommit: string }> {
  if (existsSync(worktreePath) && (await isGitRepo(worktreePath))) {
    return { created: false, baseCommit: await resolveCommit(worktreePath, 'HEAD') };
  }

  const existe = await branchExists(repoPath, branch);
  const args = existe
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', worktreePath, '-b', branch, baseRef];

  await git(repoPath, args);
  return { created: true, baseCommit: await resolveCommit(worktreePath, 'HEAD') };
}

/**
 * Prepara un espacio de trabajo de solo lectura sobre un commit concreto, sin rama.
 *
 * Lo usan las tareas que no publican código, como una investigación o una revisión cuyo
 * trabajo original ya no tiene worktree. Ningún agente trabaja en el directorio del
 * creador: un motor con Bash puede escribir donde quiera, y el único sitio donde eso no
 * hace daño es un worktree propio.
 */
export async function ensureDetachedWorktree(
  repoPath: string,
  worktreePath: string,
  commit: string,
): Promise<{ created: boolean }> {
  if (existsSync(worktreePath) && (await isGitRepo(worktreePath))) {
    return { created: false };
  }
  await git(repoPath, ['worktree', 'add', '--detach', worktreePath, commit]);
  return { created: true };
}

/**
 * Deja un worktree exactamente como su último commit: sin cambios ni ficheros nuevos.
 *
 * Se usa después de una revisión. El reviewer trabaja en el worktree del builder, y lo
 * que dejara escrito allí acabaría dentro del siguiente commit del builder.
 */
export async function discardChanges(worktreePath: string): Promise<void> {
  await git(worktreePath, ['reset', '--hard', '--quiet']);
  await git(worktreePath, ['clean', '-fd', '--quiet']);
}

/** Verdadero si el directorio de trabajo no tiene cambios sin confirmar ni ficheros nuevos. */
export async function isClean(repoPath: string): Promise<boolean> {
  return (await uncommittedFiles(repoPath)).length === 0;
}

/** Quita el worktree de una tarea y, si se pide, borra también su rama. */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  opciones: { deleteBranch?: string } = {},
): Promise<void> {
  if (existsSync(worktreePath)) {
    await git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
  }
  await git(repoPath, ['worktree', 'prune']);

  if (opciones.deleteBranch && (await branchExists(repoPath, opciones.deleteBranch))) {
    await git(repoPath, ['branch', '-D', opciones.deleteBranch]);
  }
}

/** Ficheros que cambian entre dos commits. */
export async function changedFiles(repoPath: string, desde: string, hasta: string): Promise<string[]> {
  const salida = await git(repoPath, ['diff', '--name-only', `${desde}..${hasta}`]);
  return salida ? salida.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/** Commits que hay en una rama y no están en otra, del más antiguo al más reciente. */
export async function commitsAhead(repoPath: string, base: string, rama: string): Promise<CommitInfo[]> {
  const salida = await git(repoPath, [
    'log', '--reverse', '--format=%H%x1f%s%x1f%an%x1f%aI', `${base}..${rama}`,
  ]);
  if (!salida) return [];
  return salida.split('\n').map((linea) => {
    const [sha = '', message = '', author = '', date = ''] = linea.split('\x1f');
    return { sha, message, author, date };
  });
}

export async function lastCommit(worktreePath: string): Promise<CommitInfo | null> {
  const salida = await git(worktreePath, ['log', '-1', '--format=%H%x1f%s%x1f%an%x1f%aI']);
  if (!salida) return null;
  const [sha = '', message = '', author = '', date = ''] = salida.split('\x1f');
  return { sha, message, author, date };
}

/** Ficheros modificados o sin seguimiento que hay ahora mismo en un worktree. */
export async function uncommittedFiles(worktreePath: string): Promise<string[]> {
  const salida = await git(worktreePath, ['status', '--porcelain']);
  return salida ? salida.split('\n').map((l) => l.slice(3).trim()).filter(Boolean) : [];
}

export interface MergeResult {
  merged: boolean;
  conflicts: string[];
  message: string;
}

/**
 * Fusiona la rama de una tarea en la rama principal.
 *
 * Si hay conflicto, deshace la fusión antes de devolver el control: la rama principal
 * nunca queda a medias esperando a que alguien resuelva algo a mano.
 *
 * No cambia de rama por su cuenta: quien llama comprueba antes que el repositorio está en
 * la rama principal y limpio. Cambiar de rama debajo del editor del creador, o fusionar
 * encima de sus cambios sin confirmar, es justo lo que no puede pasar.
 */
export async function mergeBranch(
  repoPath: string,
  mainBranch: string,
  taskBranch: string,
  mensaje: string,
): Promise<MergeResult> {
  const ramaActual = await currentBranch(repoPath);
  if (ramaActual !== mainBranch) {
    return {
      merged: false,
      conflicts: [],
      message: `El repositorio está en la rama ${ramaActual}, no en ${mainBranch}.`,
    };
  }

  try {
    await git(repoPath, ['merge', '--no-ff', '-m', mensaje, taskBranch]);
    return { merged: true, conflicts: [], message: 'Fusión completada.' };
  } catch (e) {
    const conflictos = await conflictedFiles(repoPath);
    await git(repoPath, ['merge', '--abort']).catch(() => undefined);
    return {
      merged: false,
      conflicts: conflictos,
      message: e instanceof GitError ? e.message : String(e),
    };
  }
}

async function conflictedFiles(repoPath: string): Promise<string[]> {
  try {
    const salida = await git(repoPath, ['diff', '--name-only', '--diff-filter=U']);
    return salida ? salida.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Deshace la última fusión de la rama principal. Se usa cuando las verificaciones fallan
 * después de integrar (documento 07, apartado 7.8).
 */
export async function undoLastMerge(repoPath: string, commitAnterior: string): Promise<void> {
  await git(repoPath, ['reset', '--hard', commitAnterior]);
}

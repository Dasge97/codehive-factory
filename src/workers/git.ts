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

/**
 * A partir de aquí, crear el repositorio deja de ser un trámite.
 *
 * Meter miles de ficheros en el primer commit tarda minutos y casi nunca es lo que se
 * quiere: suele significar que la carpeta tiene dentro varios proyectos sueltos, o
 * dependencias que nadie ha ignorado. Por encima de este número se pregunta antes.
 */
export const FICHEROS_QUE_PIDEN_CONFIRMAR = 2000;

/** Lo lanza `initRepo` cuando el primer commit se llevaría demasiados ficheros. */
export class DemasiadosFicheros extends Error {
  constructor(
    readonly files: number,
    readonly path: string,
  ) {
    super(
      `La carpeta tiene ${files.toLocaleString('es-ES')} ficheros sin ignorar, y todos entrarían en el primer commit.`,
    );
    this.name = 'DemasiadosFicheros';
  }
}

export interface RepositorioCreado {
  branch: string;
  commit: string;
  files: number;
}

/**
 * Convierte una carpeta en un repositorio de Git con un primer commit.
 *
 * El primer commit hace falta de verdad, no es un adorno: cada tarea trabaja en un
 * `git worktree` creado a partir de la rama principal, y `git worktree add` falla con
 * «invalid reference» mientras el repositorio no tenga ningún commit.
 *
 * Todo lo que haya en la carpeta entra en ese commit, salvo lo que ignore un `.gitignore`
 * que ya esté ahí. Sin contenido en el commit, el worktree de cada tarea saldría vacío y
 * los agentes no tendrían delante el proyecto.
 */
export async function initRepo(
  path: string,
  mainBranch: string,
  opciones: { confirmado?: boolean } = {},
): Promise<RepositorioCreado> {
  if (!(await isGitRepo(path))) {
    await git(path, ['init', '-b', mainBranch]);
  }

  // Con commits ya hechos no hay nada que crear: la carpeta ya sirve.
  const yaTieneCommits = await git(path, ['rev-parse', '--verify', 'HEAD'])
    .then(() => true)
    .catch(() => false);

  if (yaTieneCommits) {
    return {
      branch: await ramaActual(path),
      commit: await resolveCommit(path, 'HEAD'),
      files: 0,
    };
  }

  const sueltos = await git(path, ['ls-files', '-o', '--exclude-standard']);
  const ficheros = sueltos ? sueltos.split('\n').length : 0;

  if (ficheros > FICHEROS_QUE_PIDEN_CONFIRMAR && !opciones.confirmado) {
    throw new DemasiadosFicheros(ficheros, path);
  }

  // El primer commit de una carpeta grande tarda minutos y es cosa de una sola vez. Con el
  // tiempo máximo normal, dos minutos, se quedaba a medias.
  if (ficheros > 0) await git(path, ['add', '-A'], { timeoutMs: 900_000 });

  // El commit se hace con la identidad configurada. Si no hay ninguna, se usa una del
  // sistema para que crear el repositorio no falle por algo que no es del proyecto.
  const mensaje = 'Primer commit, creado al abrir la carpeta con Code Hive Factory';
  const tiempo = { timeoutMs: 900_000 };
  try {
    await git(path, ['commit', '--allow-empty', '-m', mensaje], tiempo);
  } catch {
    await git(
      path,
      [
        '-c', 'user.name=Code Hive Factory',
        '-c', 'user.email=codehive@localhost',
        'commit', '--allow-empty', '-m', mensaje,
      ],
      tiempo,
    );
  }

  return {
    branch: await ramaActual(path),
    commit: await resolveCommit(path, 'HEAD'),
    files: ficheros,
  };
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
 */
export async function mergeBranch(
  repoPath: string,
  mainBranch: string,
  taskBranch: string,
  mensaje: string,
): Promise<MergeResult> {
  const ramaActual = await currentBranch(repoPath);
  if (ramaActual !== mainBranch) {
    await git(repoPath, ['checkout', mainBranch]);
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
 * después de integrar (documento 07, apartado 7.7).
 */
export async function undoLastMerge(repoPath: string, commitAnterior: string): Promise<void> {
  await git(repoPath, ['reset', '--hard', commitAnterior]);
}

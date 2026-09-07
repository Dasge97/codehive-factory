import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorktree, git, initRepo, isGitRepo, ramaActual } from './git.js';

/**
 * Se puede abrir cualquier carpeta, sea o no un repositorio de Git.
 *
 * El sistema entero trabaja con ramas y worktrees, así que la carpeta acaba siendo un
 * repositorio. Lo que no puede pasar es que la persona tenga que salir a la terminal a
 * prepararla antes de poder abrirla.
 */

let carpeta: string;

beforeEach(() => {
  carpeta = mkdtempSync(join(tmpdir(), 'codehive-abrir-'));
});

afterEach(() => {
  rmSync(carpeta, { recursive: true, force: true });
});

describe('abrir una carpeta que no es un repositorio', () => {
  it('la convierte en repositorio, en la rama que pide el proyecto', async () => {
    expect(await isGitRepo(carpeta)).toBe(false);

    const creado = await initRepo(carpeta, 'main');

    expect(await isGitRepo(carpeta)).toBe(true);
    expect(creado.branch).toBe('main');
    expect(await ramaActual(carpeta)).toBe('main');
  });

  it('el primer commit se lleva lo que hubiera dentro', async () => {
    writeFileSync(join(carpeta, 'README.md'), '# Mi proyecto');
    mkdirSync(join(carpeta, 'src'));
    writeFileSync(join(carpeta, 'src', 'index.js'), 'console.log(1);');

    const creado = await initRepo(carpeta, 'main');

    expect(creado.files).toBe(2);
    const enElCommit = await git(carpeta, ['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(enElCommit.split('\n').sort()).toEqual(['README.md', 'src/index.js']);
  });

  it('respeta el .gitignore que ya hubiera', async () => {
    writeFileSync(join(carpeta, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(carpeta, 'node_modules'));
    writeFileSync(join(carpeta, 'node_modules', 'algo.js'), 'x');
    writeFileSync(join(carpeta, 'index.js'), 'x');

    await initRepo(carpeta, 'main');

    const enElCommit = await git(carpeta, ['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(enElCommit).not.toContain('node_modules');
    expect(enElCommit).toContain('index.js');
  });

  it('una carpeta vacía también vale', async () => {
    const creado = await initRepo(carpeta, 'main');

    expect(creado.files).toBe(0);
    expect(creado.commit).toHaveLength(40);
  });

  it('y desde ahí ya se pueden crear worktrees, que es lo que hace falta', async () => {
    writeFileSync(join(carpeta, 'index.js'), 'x');
    await initRepo(carpeta, 'main');

    const destino = `${carpeta}-worktree`;
    try {
      const worktree = await ensureWorktree(carpeta, destino, 'task/uno', 'main');
      expect(worktree.created).toBe(true);
      expect(worktree.baseCommit).toHaveLength(40);
    } finally {
      rmSync(destino, { recursive: true, force: true });
    }
  });
});

describe('abrir una carpeta que ya es un repositorio', () => {
  it('no toca nada si ya tiene commits', async () => {
    writeFileSync(join(carpeta, 'a.txt'), 'uno');
    await initRepo(carpeta, 'main');
    const primero = await git(carpeta, ['rev-parse', 'HEAD']);

    // Un fichero suelto que nadie ha comiteado no debe acabar en un commit por abrirla.
    writeFileSync(join(carpeta, 'b.txt'), 'dos');
    const segundo = await initRepo(carpeta, 'main');

    expect(segundo.commit).toBe(primero);
    expect(segundo.files).toBe(0);
  });

  it('un repositorio recién creado a mano, sin ningún commit, recibe el suyo', async () => {
    await git(carpeta, ['init', '-b', 'main']);
    writeFileSync(join(carpeta, 'a.txt'), 'uno');

    const creado = await initRepo(carpeta, 'main');

    expect(creado.commit).toHaveLength(40);
    expect(creado.files).toBe(1);
  });
});

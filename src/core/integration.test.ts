import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from './db.js';
import { EventBus, listEvents } from './events.js';
import { createAgent, createProject, currentDecisions } from './projects.js';
import { createTask, requireTask, setStatus } from './tasks.js';
import { claimTask } from './queue.js';
import { listFindings, openFindings, publishIncrement } from './review.js';
import { applyPlan } from './orchestrator.js';
import { integrableTasks, integrateTask } from './integration.js';
import { git, resolveCommit } from '../workers/git.js';
import type { Agent, Project, Task } from '../shared/types.js';

let db: Db;
let bus: EventBus;
let repo: string;
let worktrees: string;
let proyecto: Project;
let builder: Agent;

/** Crea un repositorio con un commit inicial y un fichero de trabajo. */
async function crearRepo(verifyCommand: string | null): Promise<void> {
  repo = mkdtempSync(join(tmpdir(), 'chf-int-'));
  worktrees = mkdtempSync(join(tmpdir(), 'chf-intwt-'));

  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'prueba@ejemplo.test']);
  await git(repo, ['config', 'user.name', 'Prueba']);
  writeFileSync(join(repo, 'texto.txt'), 'linea original\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'commit inicial']);

  proyecto = createProject(db, {
    name: 'Prueba',
    repo_path: repo,
    verify_command: verifyCommand,
  });
  builder = createAgent(db, {
    project_id: proyecto.id, name: 'Builder', role: 'builder', engine: 'claude_code',
    instructions: 'construye', allowed_tools: ['Read', 'Write'],
  });
}

/**
 * Deja una tarea terminada, con su rama y su commit, lista para integrar.
 * El contenido del fichero se pasa para poder provocar un conflicto a voluntad.
 */
async function tareaListaParaIntegrar(contenido: string): Promise<Task> {
  const task = createTask(db, bus, {
    project_id: proyecto.id, kind: 'build', title: 'Cambiar el texto',
    goal: 'Cambiar el contenido de texto.txt', required_role: 'builder', created_by: 'creator',
  });

  const rama = `task/${task.id}`;
  const worktree = join(worktrees, task.id);

  await git(repo, ['worktree', 'add', '-q', worktree, '-b', rama, 'main']);
  writeFileSync(join(worktree, 'texto.txt'), contenido);
  await git(worktree, ['add', '-A']);
  await git(worktree, [
    '-c', 'user.email=a@b.c', '-c', 'user.name=Agente', 'commit', '-q', '-m', 'cambio del agente',
  ]);

  const commit = await resolveCommit(worktree, 'HEAD');

  db.prepare('UPDATE tasks SET branch = ?, workspace_path = ? WHERE id = ?').run(rama, worktree, task.id);

  const claim = claimTask(db, bus, {
    task_id: task.id, agent_id: builder.id, worker_id: 'w1', engine: 'claude_code',
  });

  const publicado = publishIncrement(db, bus, {
    task_id: task.id, run_id: claim.run!.id, commit_sha: commit,
    branch: rama, message: 'cambio del agente', files: ['texto.txt'],
  });

  setStatus(db, bus, task.id, 'in_review');
  openFindings(db, bus, {
    review_task_id: publicado.review_task!.id,
    increment_id: publicado.increment.id,
    findings: [],
  });

  return requireTask(db, task.id);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  bus = new EventBus();
});

afterEach(() => {
  db.close();
  if (repo) rmSync(repo, { recursive: true, force: true });
  if (worktrees) rmSync(worktrees, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('P1-12 · integración correcta', () => {
  it('fusiona, ejecuta la verificación y limpia el espacio de trabajo', async () => {
    await crearRepo('git --version');
    const task = await tareaListaParaIntegrar('linea cambiada por el agente\n');

    expect(integrableTasks(db, proyecto.id).map((t) => t.id)).toEqual([task.id]);

    const resultado = await integrateTask(db, bus, task.id);

    expect(resultado.integrated).toBe(true);
    expect(resultado.verification?.passed).toBe(true);

    const enMain = await git(repo, ['show', 'main:texto.txt']);
    expect(enMain).toContain('linea cambiada por el agente');

    // El worktree se elimina y los bloqueos quedan liberados.
    expect(requireTask(db, task.id).workspace_path).toBeNull();
    const worktreesVivos = await git(repo, ['worktree', 'list']);
    expect(worktreesVivos).not.toContain(task.id);

    expect(listEvents(db, proyecto.id).map((e) => e.type)).toContain('integration.completed');
  });

  it('una revisión no aparece como integrable', async () => {
    await crearRepo(null);
    const task = await tareaListaParaIntegrar('otra linea\n');

    const revision = db
      .prepare("SELECT id FROM tasks WHERE parent_task_id = ? AND kind = 'review'")
      .get(task.id) as { id: string };
    setStatus(db, bus, revision.id, 'in_progress');
    setStatus(db, bus, revision.id, 'done');

    expect(integrableTasks(db, proyecto.id).map((t) => t.id)).toEqual([task.id]);
  });
});

describe('P1-07 · conflicto al fusionar', () => {
  it('no integra, devuelve la tarea a la cola y deja un aviso', async () => {
    await crearRepo(null);
    const task = await tareaListaParaIntegrar('version del agente\n');

    // Mientras tanto, la rama principal cambia la misma línea.
    writeFileSync(join(repo, 'texto.txt'), 'version de la rama principal\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'cambio en la rama principal']);
    const commitAntes = await resolveCommit(repo, 'main');

    const resultado = await integrateTask(db, bus, task.id);

    expect(resultado.integrated).toBe(false);
    expect(resultado.reason).toMatch(/conflicto/i);
    expect(resultado.conflicts).toContain('texto.txt');

    // La rama principal queda exactamente como estaba.
    expect(await resolveCommit(repo, 'main')).toBe(commitAntes);
    const enMain = await git(repo, ['show', 'main:texto.txt']);
    expect(enMain).toContain('version de la rama principal');

    // La tarea vuelve a la cola con el motivo, y el builder recibe el aviso.
    const actualizada = requireTask(db, task.id);
    expect(actualizada.status).toBe('ready');

    const avisos = db
      .prepare('SELECT body FROM notices WHERE task_id = ?')
      .all(task.id) as Array<{ body: string }>;
    expect(avisos.some((a) => /conflicto/i.test(a.body))).toBe(true);
  });
});

describe('P1-08 · la verificación falla tras fusionar', () => {
  it('deshace la fusión y devuelve la misma tarea a la cola con un hallazgo bloqueante', async () => {
    // Un comando que siempre termina con error, para simular pruebas que fallan.
    await crearRepo('git rev-parse --verify no-existe-esta-referencia');
    const task = await tareaListaParaIntegrar('linea que rompe las pruebas\n');

    const commitAntes = await resolveCommit(repo, 'main');

    const resultado = await integrateTask(db, bus, task.id);

    expect(resultado.integrated).toBe(false);
    expect(resultado.reason).toMatch(/verificaciones fallaron/i);
    expect(resultado.verification?.passed).toBe(false);

    // La rama principal vuelve a como estaba antes de fusionar.
    expect(await resolveCommit(repo, 'main')).toBe(commitAntes);
    const enMain = await git(repo, ['show', 'main:texto.txt']);
    expect(enMain).toContain('linea original');

    // No se crea ninguna tarea aparte: la propia tarea vuelve a la cola, con prioridad
    // alta, sobre su misma rama, y con el hallazgo que dice qué tiene que cumplir.
    expect(resultado.finding_id).toBeDefined();
    const correcciones = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'fix'").get() as { n: number };
    expect(correcciones.n).toBe(0);

    const actualizada = requireTask(db, task.id);
    expect(actualizada.status).toBe('ready');
    expect(actualizada.priority).toBe(5);
    expect(actualizada.branch).toBe(task.branch);

    const hallazgos = listFindings(db, task.id);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.severity).toBe('blocker');
    expect(hallazgos[0]!.resolution).toMatch(/pasa con la rama fusionada/);
  });
});

describe('D45 · la integración no toca la copia de trabajo del creador', () => {
  it('con cambios sin confirmar en el repositorio, se niega sin cambiar nada', async () => {
    await crearRepo(null);
    const task = await tareaListaParaIntegrar('linea nueva\n');

    // El creador tiene un fichero a medias en su copia de trabajo.
    writeFileSync(join(repo, 'a-medias.txt'), 'trabajo del creador sin guardar\n');
    const commitAntes = await resolveCommit(repo, 'main');

    const resultado = await integrateTask(db, bus, task.id);

    expect(resultado.integrated).toBe(false);
    expect(resultado.reason).toMatch(/cambios sin confirmar/);
    expect(await resolveCommit(repo, 'main')).toBe(commitAntes);
    expect(requireTask(db, task.id).status).toBe('done');
    expect(readFileSync(join(repo, 'a-medias.txt'), 'utf8')).toContain('sin guardar');
  });

  it('si el repositorio no está en la rama principal, se niega en vez de cambiar de rama', async () => {
    await crearRepo(null);
    const task = await tareaListaParaIntegrar('linea nueva\n');
    await git(repo, ['checkout', '-q', '-b', 'trabajo-del-creador']);

    const resultado = await integrateTask(db, bus, task.id);

    expect(resultado.integrated).toBe(false);
    expect(resultado.reason).toMatch(/trabajo-del-creador/);
    expect(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('trabajo-del-creador');
  });

  it('si la rama tiene commits que nadie revisó, se niega', async () => {
    await crearRepo(null);
    const task = await tareaListaParaIntegrar('linea nueva\n');

    // Alguien añade un commit a la rama después de la aprobación.
    const worktree = requireTask(db, task.id).workspace_path!;
    writeFileSync(join(worktree, 'extra.txt'), 'sin revisar\n');
    await git(worktree, ['add', '-A']);
    await git(worktree, ['-c', 'user.email=a@b.c', '-c', 'user.name=Agente', 'commit', '-q', '-m', 'extra']);

    const resultado = await integrateTask(db, bus, task.id);

    expect(resultado.integrated).toBe(false);
    expect(resultado.reason).toMatch(/no han pasado por revisión/);
  });
});

describe('P1-06 · cambio de requisito', () => {
  it('marca para reevaluar solo el trabajo anterior a la decisión nueva', async () => {
    await crearRepo(null);

    // Primera decisión y una tarea creada con ella.
    applyPlan(db, bus, proyecto.id, {
      reply: 'Registro la primera decisión.',
      decisions: [{ title: 'Formato de los nombres', body: 'Los nombres van en minúsculas.' }],
      tasks: [{ title: 'Validar nombres', goal: 'Implementar la validación', kind: 'build', role: 'builder' }],
    });

    const antigua = db.prepare("SELECT * FROM tasks WHERE title = 'Validar nombres'").get() as Task;
    expect(antigua.decision_revision).toBe(1);

    // El creador cambia de idea: decisión nueva que sustituye a la anterior.
    applyPlan(db, bus, proyecto.id, {
      reply: 'He cambiado la decisión sobre los nombres.',
      decisions: [
        {
          title: 'Formato de los nombres',
          body: 'Los nombres respetan mayúsculas y minúsculas.',
          supersedes_title: 'Formato de los nombres',
        },
      ],
      tasks: [{ title: 'Pantalla de listado', goal: 'Mostrar la lista', kind: 'build', role: 'builder' }],
    });

    // La tarea anterior queda marcada para reevaluar.
    expect(requireTask(db, antigua.id).needs_reeval).toBe(1);

    // La tarea creada con la decisión nueva no se toca.
    const nueva = db.prepare("SELECT * FROM tasks WHERE title = 'Pantalla de listado'").get() as Task;
    expect(nueva.needs_reeval).toBe(0);
    expect(nueva.decision_revision).toBe(2);

    // Solo queda vigente la decisión nueva.
    const vigentes = currentDecisions(db, proyecto.id);
    expect(vigentes).toHaveLength(1);
    expect(vigentes[0]!.body).toMatch(/respetan mayúsculas/);

    expect(listEvents(db, proyecto.id).map((e) => e.type)).toContain('decision.recorded');
  });

  it('una tarea ya terminada no se marca para reevaluar', async () => {
    await crearRepo(null);

    applyPlan(db, bus, proyecto.id, {
      reply: 'Primera decisión.',
      decisions: [{ title: 'Regla', body: 'Versión uno.' }],
      tasks: [{ title: 'Trabajo hecho', goal: 'Objetivo', kind: 'build', role: 'builder' }],
    });

    const hecha = db.prepare("SELECT * FROM tasks WHERE title = 'Trabajo hecho'").get() as Task;
    setStatus(db, bus, hecha.id, 'in_progress');
    setStatus(db, bus, hecha.id, 'done');

    applyPlan(db, bus, proyecto.id, {
      reply: 'Cambio la regla.',
      decisions: [{ title: 'Regla', body: 'Versión dos.', supersedes_title: 'Regla' }],
    });

    expect(requireTask(db, hecha.id).needs_reeval).toBe(0);
  });
});

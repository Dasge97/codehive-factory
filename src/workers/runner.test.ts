import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../core/db.js';
import { EventBus, listEvents } from '../core/events.js';
import { createAgent, createProject, updateProject } from '../core/projects.js';
import { createTask, requireTask, setStatus } from '../core/tasks.js';
import { claimTask } from '../core/queue.js';
import { listIncrements } from '../core/review.js';
import { parseResult, runTask } from './runner.js';
import { git } from './git.js';
import type { Engine, EngineHandle, EngineRunOutcome, EngineRunRequest } from '../engines/types.js';
import type { Agent, Project, Task } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Motor simulado: devuelve lo que se le diga sin llamar a ningún modelo.
// ---------------------------------------------------------------------------

class MotorSimulado implements Engine {
  readonly name = 'claude_code' as const;
  peticiones: EngineRunRequest[] = [];

  constructor(
    private readonly respuesta: Partial<EngineRunOutcome>,
    private readonly alEjecutar?: (req: EngineRunRequest) => Promise<void>,
  ) {}

  capabilities() {
    return {
      resumeSession: true, resultSchema: true, usageReporting: true, costReporting: true,
      budgetLimit: true, permissionDenials: true, stop: true,
    };
  }

  async check() {
    return { ok: true, version: 'simulado' };
  }

  start(request: EngineRunRequest): EngineHandle {
    this.peticiones.push(request);
    const trabajo = (async () => {
      if (this.alEjecutar) await this.alEjecutar(request);
      return {
        status: 'succeeded', sessionId: 'ses-simulada', resultText: null, costUsd: 0.01,
        inputTokens: 10, outputTokens: 20, permissionDenials: [], terminalReason: null,
        usage: null, error: null,
        ...this.respuesta,
      } as EngineRunOutcome;
    })();
    return { wait: () => trabajo, stop: () => undefined };
  }
}

const resultadoCompleto = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ outcome: 'completed', summary: 'Trabajo hecho.', ...extra });

// ---------------------------------------------------------------------------

let db: Db;
let bus: EventBus;
let repo: string;
let workspaces: string;
let proyecto: Project;
let builder: Agent;

beforeEach(async () => {
  db = openDatabase(':memory:');
  bus = new EventBus();

  repo = mkdtempSync(join(tmpdir(), 'chf-repo-'));
  workspaces = mkdtempSync(join(tmpdir(), 'chf-ws-'));
  process.env['CODEHIVE_WORKSPACES'] = workspaces;

  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'prueba@ejemplo.test']);
  await git(repo, ['config', 'user.name', 'Prueba']);
  writeFileSync(join(repo, 'inicial.txt'), 'contenido inicial\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'commit inicial']);

  proyecto = createProject(db, { name: 'Prueba', repo_path: repo, max_task_attempts: 2 });
  builder = createAgent(db, {
    project_id: proyecto.id, name: 'Builder', role: 'builder', engine: 'claude_code',
    instructions: 'construye', allowed_tools: ['Read', 'Write', 'Bash'],
  });
  createAgent(db, {
    project_id: proyecto.id, name: 'Reviewer', role: 'reviewer', engine: 'claude_code',
    instructions: 'revisa', allowed_tools: ['Read'],
  });
});

afterEach(() => {
  delete process.env['CODEHIVE_WORKSPACES'];
  rmSync(repo, { recursive: true, force: true });
  rmSync(workspaces, { recursive: true, force: true });
});

function tareaLista(extra: Partial<Parameters<typeof createTask>[2]> = {}): Task {
  return createTask(db, bus, {
    project_id: proyecto.id, kind: 'build', title: 'Tarea', goal: 'Objetivo',
    required_role: 'builder', created_by: 'creator', ...extra,
  });
}

async function ejecutar(task: Task, motor: Engine) {
  const claim = claimTask(db, bus, {
    task_id: task.id, agent_id: builder.id, worker_id: 'w1', engine: 'claude_code',
  });
  return runTask(db, bus, {
    task: requireTask(db, task.id), agent: builder, run: claim.run!, engine: motor,
  });
}

// ---------------------------------------------------------------------------

describe('validación del resultado del agente', () => {
  it('acepta un resultado que cumple el contrato', () => {
    const { result, parseError } = parseResult(resultadoCompleto());
    expect(parseError).toBeNull();
    expect(result!.outcome).toBe('completed');
  });

  it('rechaza un resultado ausente', () => {
    expect(parseResult(null).parseError).toMatch(/no devolvió ningún resultado/);
  });

  it('rechaza texto que no es JSON', () => {
    expect(parseResult('lo he hecho, saludos').parseError).toMatch(/no es JSON válido/);
  });

  it('rechaza un JSON al que le falta un campo obligatorio', () => {
    expect(parseResult('{"outcome":"completed"}').parseError).toMatch(/no cumple el contrato/);
  });

  it('rechaza un valor de outcome que no existe', () => {
    const { parseError } = parseResult('{"outcome":"casi","summary":"x"}');
    expect(parseError).toMatch(/no cumple el contrato/);
  });
});

describe('preparación del espacio de trabajo', () => {
  it('una tarea que escribe código recibe su propio worktree y su rama', async () => {
    const t = tareaLista();
    const motor = new MotorSimulado({ resultText: resultadoCompleto() });
    await ejecutar(t, motor);

    const actualizada = requireTask(db, t.id);
    expect(actualizada.branch).toBe(`task/${t.id}`);
    expect(actualizada.workspace_path).toContain(t.id);
    expect(motor.peticiones[0]!.cwd).toBe(actualizada.workspace_path);
  });

  it('una tarea de investigación trabaja sobre el repositorio, sin worktree', async () => {
    const t = tareaLista({ kind: 'research', required_role: 'builder' });
    const motor = new MotorSimulado({ resultText: resultadoCompleto() });
    await ejecutar(t, motor);
    expect(motor.peticiones[0]!.cwd).toBe(repo);
  });

  it('el encargo llega al motor con el objetivo y las herramientas del agente', async () => {
    const t = tareaLista({ goal: 'Implementar la validación de nombres' });
    const motor = new MotorSimulado({ resultText: resultadoCompleto() });
    await ejecutar(t, motor);

    expect(motor.peticiones[0]!.prompt).toContain('Implementar la validación de nombres');
    expect(motor.peticiones[0]!.allowedTools).toEqual(['Read', 'Write', 'Bash']);
    expect(motor.peticiones[0]!.resultSchema).toBeDefined();
  });
});

describe('publicación del trabajo', () => {
  it('un commit en el worktree se registra como incremento y abre su revisión', async () => {
    const t = tareaLista();
    const motor = new MotorSimulado({ resultText: resultadoCompleto() }, async (req) => {
      writeFileSync(join(req.cwd, 'nuevo.txt'), 'trabajo del agente\n');
      await git(req.cwd, ['add', '-A']);
      await git(req.cwd, ['-c', 'user.email=a@b.c', '-c', 'user.name=Agente', 'commit', '-q', '-m', 'incremento del agente']);
    });

    const r = await ejecutar(t, motor);

    expect(r.incrementId).not.toBeNull();
    const incrementos = listIncrements(db, t.id);
    expect(incrementos).toHaveLength(1);
    expect(incrementos[0]!.message).toBe('incremento del agente');
    expect(incrementos[0]!.files_json).toContain('nuevo.txt');

    expect(requireTask(db, t.id).status).toBe('in_review');

    const revision = db
      .prepare("SELECT * FROM tasks WHERE parent_task_id = ? AND kind = 'review'")
      .get(t.id) as Task;
    expect(revision.base_commit).toBe(incrementos[0]!.commit_sha);
  });

  it('sin commit no hay incremento y la tarea queda hecha', async () => {
    const t = tareaLista();
    const motor = new MotorSimulado({ resultText: resultadoCompleto() });
    const r = await ejecutar(t, motor);

    expect(r.incrementId).toBeNull();
    expect(requireTask(db, t.id).status).toBe('done');
  });
});

describe('cierre de la ejecución', () => {
  it('guarda coste, tokens y sesión del motor', async () => {
    const t = tareaLista();
    await ejecutar(t, new MotorSimulado({ resultText: resultadoCompleto() }));

    const run = db.prepare('SELECT * FROM runs WHERE task_id = ?').get(t.id) as {
      status: string; cost_usd: number; input_tokens: number; engine_session_id: string; summary: string;
    };
    expect(run.status).toBe('succeeded');
    expect(run.cost_usd).toBeCloseTo(0.01);
    expect(run.input_tokens).toBe(10);
    expect(run.engine_session_id).toBe('ses-simulada');
    expect(run.summary).toBe('Trabajo hecho.');
  });

  it('un resultado que no cumple el contrato deja la ejecución fallida', async () => {
    const t = tareaLista();
    await ejecutar(t, new MotorSimulado({ resultText: 'no soy JSON' }));

    const run = db.prepare('SELECT * FROM runs WHERE task_id = ?').get(t.id) as {
      status: string; error: string;
    };
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/no es JSON válido/);
    expect(requireTask(db, t.id).status).toBe('ready');
  });

  it('un resultado bloqueado deja la tarea bloqueada con su motivo', async () => {
    const t = tareaLista();
    await ejecutar(
      t,
      new MotorSimulado({
        resultText: JSON.stringify({ outcome: 'blocked', summary: 'Necesito tocar un fichero fuera de mi reserva.' }),
      }),
    );

    const actualizada = requireTask(db, t.id);
    expect(actualizada.status).toBe('blocked');
    expect(actualizada.blocked_reason).toMatch(/fuera de mi reserva/);
  });

  it('al agotar los intentos la tarea se bloquea en vez de reintentar sin fin', async () => {
    const t = tareaLista();
    const motor = new MotorSimulado({ resultText: 'roto' });

    await ejecutar(t, motor);
    expect(requireTask(db, t.id).status).toBe('ready');

    await ejecutar(t, motor);
    const actualizada = requireTask(db, t.id);
    expect(actualizada.status).toBe('blocked');
    expect(actualizada.blocked_reason).toMatch(/falló 2 veces/);
  });

  it('un fallo de credenciales bloquea sin gastar intentos', async () => {
    const t = tareaLista();
    await ejecutar(
      t,
      new MotorSimulado({ status: 'failed', terminalReason: 'api_error', error: 'sin credenciales' }),
    );

    const actualizada = requireTask(db, t.id);
    expect(actualizada.status).toBe('blocked');
    expect(actualizada.blocked_reason).toMatch(/credenciales/);
  });

  it('el tiempo agotado devuelve la tarea a la cola', async () => {
    const t = tareaLista();
    await ejecutar(t, new MotorSimulado({ status: 'timed_out', error: 'superó el tiempo máximo' }));

    const run = db.prepare('SELECT status FROM runs WHERE task_id = ?').get(t.id) as { status: string };
    expect(run.status).toBe('timed_out');
    expect(requireTask(db, t.id).status).toBe('ready');
  });
});

describe('autorizaciones y consumo', () => {
  it('una acción denegada se convierte en petición de autorización', async () => {
    const t = tareaLista();
    await ejecutar(
      t,
      new MotorSimulado({
        resultText: resultadoCompleto(),
        permissionDenials: [{ tool_name: 'WebFetch', tool_input: { url: 'https://ejemplo.test' } }],
      }),
    );

    const aprobacion = db.prepare('SELECT * FROM approvals WHERE task_id = ?').get(t.id) as {
      status: string; tool_name: string; tool_input: string;
    };
    expect(aprobacion.status).toBe('pending');
    expect(aprobacion.tool_name).toBe('WebFetch');
    expect(JSON.parse(aprobacion.tool_input)).toEqual({ url: 'https://ejemplo.test' });
    expect(listEvents(db, proyecto.id).map((e) => e.type)).toContain('approval.requested');
  });

  it('guarda el consumo de la suscripción que informa el motor', async () => {
    const t = tareaLista();
    await ejecutar(
      t,
      new MotorSimulado({
        resultText: resultadoCompleto(),
        usage: {
          status: 'allowed', fiveHourUtilization: 0.12, fiveHourResetsAt: '2026-09-06T18:00:00.000Z',
          sevenDayUtilization: 0.4, sevenDayResetsAt: '2026-09-12T00:00:00.000Z', usingOverage: false,
        },
      }),
    );

    const uso = db.prepare("SELECT * FROM engine_usage WHERE engine = 'claude_code'").get() as {
      five_hour_util: number; seven_day_util: number; using_overage: number;
    };
    expect(uso.five_hour_util).toBeCloseTo(0.12);
    expect(uso.seven_day_util).toBeCloseTo(0.4);
    expect(uso.using_overage).toBe(0);
  });
});

describe('registro de la ejecución', () => {
  it('deja evento de inicio y de fin', async () => {
    const t = tareaLista();
    await ejecutar(t, new MotorSimulado({ resultText: resultadoCompleto() }));

    const tipos = listEvents(db, proyecto.id).map((e) => e.type);
    expect(tipos).toContain('run.started');
    expect(tipos).toContain('run.finished');
  });
});

describe('fallos encontrados en la primera prueba con agentes reales', () => {
  it('el agente puede ejecutar comandos dentro de su worktree', async () => {
    const t = tareaLista();
    const motor = new MotorSimulado({ resultText: resultadoCompleto() });
    await ejecutar(t, motor);

    // Con acceptEdits el agente escribe ficheros pero no puede hacer commit ni ejecutar
    // las pruebas, y todo comando se le deniega.
    expect(motor.peticiones[0]!.permissionMode).toBe('bypassPermissions');
  });

  it('el worker confirma los cambios que el agente dejó sin confirmar', async () => {
    const t = tareaLista();
    const motor = new MotorSimulado({ resultText: resultadoCompleto() }, async (req) => {
      // El agente escribe el fichero pero no llega a hacer commit.
      writeFileSync(join(req.cwd, 'sin-commit.txt'), 'trabajo del agente\n');
    });

    const r = await ejecutar(t, motor);

    expect(r.incrementId).not.toBeNull();
    const incrementos = listIncrements(db, t.id);
    expect(incrementos).toHaveLength(1);
    expect(incrementos[0]!.files_json).toContain('sin-commit.txt');
    expect(requireTask(db, t.id).status).toBe('in_review');
  });

  it('avanzar sin terminar también gasta intentos', async () => {
    const t = tareaLista();
    const motor = new MotorSimulado({
      resultText: JSON.stringify({ outcome: 'partial', summary: 'He avanzado un poco.' }),
    });

    await ejecutar(t, motor);
    expect(requireTask(db, t.id).status).toBe('ready');

    await ejecutar(t, motor);
    const actualizada = requireTask(db, t.id);
    expect(actualizada.status).toBe('blocked');
    expect(actualizada.blocked_reason).toMatch(/avanzó sin terminar en 2 intentos/);
  });
});

describe('P2-04 · una petición de apoyo se convierte en una tarea', () => {
  it('crea la tarea de apoyo y la original la espera', async () => {
    createAgent(db, {
      project_id: proyecto.id, name: 'Investigador', role: 'researcher', engine: 'claude_code',
      instructions: 'investiga', allowed_tools: ['Read'],
    });

    const t = tareaLista();
    const motor = new MotorSimulado({
      resultText: JSON.stringify({
        outcome: 'partial',
        summary: 'No sé cómo valida los nombres el resto del proyecto.',
        needs: ['Averiguar dónde está la validación de nombres actual.'],
      }),
    });

    await ejecutar(t, motor);

    const apoyo = db
      .prepare("SELECT * FROM tasks WHERE kind = 'research'")
      .get() as Task;
    expect(apoyo).toBeDefined();
    expect(apoyo.required_role).toBe('researcher');
    expect(apoyo.goal).toMatch(/validación de nombres/);
    expect(apoyo.parent_task_id).toBe(t.id);

    // La tarea que pidió el apoyo queda esperando, no reintentando a ciegas.
    const original = requireTask(db, t.id);
    expect(original.status).toBe('pending');
    expect(original.blocked_reason).toBeNull();

    const dependencia = db
      .prepare('SELECT depends_on_id FROM task_dependencies WHERE task_id = ?')
      .get(t.id) as { depends_on_id: string };
    expect(dependencia.depends_on_id).toBe(apoyo.id);
  });
});

describe('el apoyo no se pide dos veces', () => {
  it('mientras el apoyo esté abierto, la tarea no se puede reclamar', async () => {
    createAgent(db, {
      project_id: proyecto.id, name: 'Investigador', role: 'researcher', engine: 'claude_code',
      instructions: 'investiga', allowed_tools: ['Read'],
    });

    const t = tareaLista();
    const motor = new MotorSimulado({
      resultText: JSON.stringify({
        outcome: 'partial',
        summary: 'Sigo sin saberlo.',
        needs: ['Averiguar cómo valida los nombres el proyecto.'],
      }),
    });

    await ejecutar(t, motor);

    // La dependencia con la tarea de apoyo impide reclamarla otra vez, así que no puede
    // volver a pedir lo mismo mientras espera.
    setStatus(db, bus, t.id, 'ready', 'prueba');
    const segundo = claimTask(db, bus, {
      task_id: t.id, agent_id: builder.id, worker_id: 'w2', engine: 'claude_code',
    });

    expect(segundo.claimed).toBe(false);
    expect(segundo.reason).toMatch(/espera a que terminen/i);

    const apoyos = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'research'").get() as { n: number };
    expect(apoyos.n).toBe(1);
  });
});

describe('los apoyos no se encadenan', () => {
  const conNeeds = () =>
    new MotorSimulado({
      resultText: JSON.stringify({
        outcome: 'partial',
        summary: 'Necesito saber algo más.',
        needs: ['Otra pregunta.'],
      }),
    });

  it('una tarea de investigación no pide apoyo', async () => {
    createAgent(db, {
      project_id: proyecto.id, name: 'Investigador', role: 'researcher', engine: 'claude_code',
      instructions: 'investiga', allowed_tools: ['Read'],
    });

    const t = tareaLista({ kind: 'research', required_role: 'builder' });
    await ejecutar(t, conNeeds());

    const apoyos = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'research'").get() as { n: number };
    // Solo existe la propia tarea de investigación, sin ninguna hija.
    expect(apoyos.n).toBe(1);
  });

  it('una revisión no pide apoyo', async () => {
    createAgent(db, {
      project_id: proyecto.id, name: 'Investigador', role: 'researcher', engine: 'claude_code',
      instructions: 'investiga', allowed_tools: ['Read'],
    });

    const t = tareaLista({ kind: 'review', required_role: 'builder' });
    await ejecutar(t, conNeeds());

    const apoyos = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'research'").get() as { n: number };
    expect(apoyos.n).toBe(0);
  });
});

describe('la revisión se cierra al dar su veredicto', () => {
  it('una revisión sin hallazgos queda hecha', async () => {
    const reviewer = createAgent(db, {
      project_id: proyecto.id, name: 'Reviewer 2', role: 'reviewer', engine: 'codex',
      instructions: 'revisa', allowed_tools: ['Read'],
    });

    // Se prepara una construcción con incremento publicado y su revisión abierta.
    const build = tareaLista();
    const motorBuilder = new MotorSimulado({ resultText: resultadoCompleto() }, async (req) => {
      writeFileSync(join(req.cwd, 'nuevo.txt'), 'contenido\n');
    });
    await ejecutar(build, motorBuilder);

    const revision = db
      .prepare("SELECT * FROM tasks WHERE parent_task_id = ? AND kind = 'review'")
      .get(build.id) as Task;
    expect(revision).toBeDefined();

    // El reviewer dice que avanzó sin terminar, pero entrega su veredicto sin hallazgos.
    const claim = claimTask(db, bus, {
      task_id: revision.id, agent_id: reviewer.id, worker_id: 'wr', engine: 'codex',
    });
    await runTask(db, bus, {
      task: requireTask(db, revision.id),
      agent: reviewer,
      run: claim.run!,
      engine: new MotorSimulado({
        resultText: JSON.stringify({ outcome: 'partial', summary: 'He revisado el commit.', findings: [] }),
      }),
    });

    expect(requireTask(db, revision.id).status).toBe('done');
    expect(requireTask(db, build.id).status).toBe('done');
  });
});

describe('la verificación la ejecuta el sistema, no el agente', () => {
  /** Motor que hace un commit en el worktree y declara la verificación que se le indique. */
  function motorQueComitea(verification: unknown) {
    return new MotorSimulado({ resultText: resultadoCompleto({ verification }) }, async (req) => {
      writeFileSync(join(req.cwd, 'nuevo.txt'), 'trabajo del agente\n');
      await git(req.cwd, ['add', '-A']);
      await git(req.cwd, ['-c', 'user.email=a@b.c', '-c', 'user.name=Agente', 'commit', '-q', '-m', 'incremento']);
    });
  }

  function revisionDe(taskId: string) {
    return db
      .prepare("SELECT * FROM tasks WHERE parent_task_id = ? AND kind = 'review'")
      .get(taskId) as Task | undefined;
  }

  it('si el agente dice que la verificación pasa y no pasa, el trabajo se revisa igual', async () => {
    updateProject(db, proyecto.id, { verify_command: 'node --opcion-que-no-existe' });
    const t = tareaLista({ needs_review: false });

    await ejecutar(t, motorQueComitea({ ran: true, command: 'npm test', passed: true }));

    expect(revisionDe(t.id)).toBeDefined();
    expect(requireTask(db, t.id).status).toBe('in_review');
  });

  it('deja un aviso para el siguiente intento cuando el agente declaró algo que no era cierto', async () => {
    updateProject(db, proyecto.id, { verify_command: 'node --opcion-que-no-existe' });
    const t = tareaLista({ needs_review: false });

    await ejecutar(t, motorQueComitea({ ran: true, command: 'npm test', passed: true }));

    const avisos = db.prepare('SELECT * FROM notices WHERE task_id = ?').all(t.id) as Array<{ body: string }>;
    expect(avisos.some((a) => a.body.includes('no pasa'))).toBe(true);
  });

  it('si el agente no la ejecutó pero el sistema la ejecuta y pasa, la tarea queda hecha', async () => {
    updateProject(db, proyecto.id, { verify_command: 'node --version' });
    const t = tareaLista({ needs_review: false });

    await ejecutar(t, motorQueComitea({ ran: false, command: null, passed: null }));

    expect(revisionDe(t.id)).toBeUndefined();
    expect(requireTask(db, t.id).status).toBe('done');
  });

  it('el resultado que devuelve el worker lleva la verificación medida, no la declarada', async () => {
    updateProject(db, proyecto.id, { verify_command: 'node --version' });
    const t = tareaLista();

    const r = await ejecutar(t, motorQueComitea({ ran: true, command: 'npm test', passed: false }));

    expect(r.result!.verification).toMatchObject({ ran: true, command: 'node --version', passed: true });
  });

  it('una tarea que no escribe código no ejecuta la verificación', async () => {
    updateProject(db, proyecto.id, { verify_command: 'node --opcion-que-no-existe' });
    const t = tareaLista({ kind: 'research', required_role: 'builder' });

    const motor = new MotorSimulado({
      resultText: resultadoCompleto({ verification: { ran: true, command: 'npm test', passed: true } }),
    });
    const r = await ejecutar(t, motor);

    expect(r.result!.verification).toMatchObject({ command: 'npm test', passed: true });
  });
});

describe('ficheros protegidos del proyecto', () => {
  /** Motor que escribe el fichero que se le indique y lo comitea. */
  function motorQueTocaFichero(nombre: string) {
    return new MotorSimulado({ resultText: resultadoCompleto() }, async (req) => {
      writeFileSync(join(req.cwd, nombre), 'contenido\n');
      await git(req.cwd, ['add', '-A']);
      await git(req.cwd, ['-c', 'user.email=a@b.c', '-c', 'user.name=Agente', 'commit', '-q', '-m', 'cambio']);
    });
  }

  it('el encargo le dice al agente qué ficheros no puede tocar', async () => {
    updateProject(db, proyecto.id, { protected_paths: JSON.stringify(['package-lock.json']) });
    const t = tareaLista();
    const motor = new MotorSimulado({ resultText: resultadoCompleto() });
    await ejecutar(t, motor);

    expect(motor.peticiones[0]!.prompt).toContain('Ficheros protegidos del proyecto');
    expect(motor.peticiones[0]!.prompt).toContain('package-lock.json');
  });

  it('un commit que toca un fichero protegido no se publica y bloquea la tarea', async () => {
    updateProject(db, proyecto.id, { protected_paths: JSON.stringify(['package-lock.json']) });
    const t = tareaLista();

    const r = await ejecutar(t, motorQueTocaFichero('package-lock.json'));

    expect(r.incrementId).toBeNull();
    expect(listIncrements(db, t.id)).toHaveLength(0);

    const actualizada = requireTask(db, t.id);
    expect(actualizada.status).toBe('blocked');
    expect(actualizada.blocked_reason).toContain('package-lock.json');
    expect(actualizada.head_commit).toBeNull();
  });

  it('el agente recibe el motivo en su siguiente intento', async () => {
    updateProject(db, proyecto.id, { protected_paths: JSON.stringify(['package-lock.json']) });
    const t = tareaLista();

    await ejecutar(t, motorQueTocaFichero('package-lock.json'));

    const avisos = db.prepare('SELECT * FROM notices WHERE task_id = ?').all(t.id) as Array<{ body: string }>;
    expect(avisos.some((a) => a.body.includes('package-lock.json'))).toBe(true);
  });

  it('un fichero que no cae en ningún patrón protegido se publica sin problema', async () => {
    updateProject(db, proyecto.id, { protected_paths: JSON.stringify(['.github/**']) });
    const t = tareaLista();

    const r = await ejecutar(t, motorQueTocaFichero('package-lock.json'));

    expect(r.incrementId).not.toBeNull();
    expect(requireTask(db, t.id).status).toBe('in_review');
  });

  it('sin ficheros protegidos declarados, el trabajo se publica como siempre', async () => {
    const t = tareaLista();
    const r = await ejecutar(t, motorQueTocaFichero('package-lock.json'));
    expect(r.incrementId).not.toBeNull();
  });
});

describe('aislamiento de la configuración personal', () => {
  it('por omisión el motor no recibe la configuración personal del equipo', async () => {
    const t = tareaLista();
    const motor = new MotorSimulado({ resultText: resultadoCompleto() });
    await ejecutar(t, motor);
    expect(motor.peticiones[0]!.usePersonalConfig).toBe(false);
  });

  it('con el interruptor activado, el motor la recibe', async () => {
    updateProject(db, proyecto.id, { use_personal_config: 1 });
    const t = tareaLista();
    const motor = new MotorSimulado({ resultText: resultadoCompleto() });
    await ejecutar(t, motor);
    expect(motor.peticiones[0]!.usePersonalConfig).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../app.js';
import { FakeEngine, planDeOrquestador, resultadoDeAgente } from '../engines/fake-engine.js';
import { createTask, requireTask } from '../core/tasks.js';
import { claimTask } from '../core/queue.js';
import { publishIncrement } from '../core/review.js';
import { agentForRole } from '../core/projects.js';
import { git } from '../workers/git.js';
import { AGENT_ROLES } from '../shared/types.js';

let app: App;
let repo: string;
let workspaces: string;
let base: string;
let motor: FakeEngine;

async function crearRepo(): Promise<string> {
  const ruta = mkdtempSync(join(tmpdir(), 'chf-api-'));
  await git(ruta, ['init', '-q', '-b', 'main']);
  await git(ruta, ['config', 'user.email', 'prueba@ejemplo.test']);
  await git(ruta, ['config', 'user.name', 'Prueba']);
  writeFileSync(join(ruta, 'README.md'), '# proyecto de prueba\n');
  await git(ruta, ['add', '-A']);
  await git(ruta, ['commit', '-q', '-m', 'commit inicial']);
  return ruta;
}

beforeEach(async () => {
  repo = await crearRepo();
  workspaces = mkdtempSync(join(tmpdir(), 'chf-apiws-'));
  process.env['CODEHIVE_WORKSPACES'] = workspaces;

  writeFileSync(
    join(repo, 'codehive.project.json'),
    JSON.stringify({ name: 'Proyecto de prueba', main_branch: 'main' }, null, 2),
  );

  motor = new FakeEngine({ resultText: resultadoDeAgente() });
  app = await createApp({ dbPath: ':memory:', repoPath: repo, port: 0, engine: motor });
  const { port } = await app.start();
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await app.stop();
  delete process.env['CODEHIVE_WORKSPACES'];
  rmSync(repo, { recursive: true, force: true });
  rmSync(workspaces, { recursive: true, force: true });
});

/** Respuesta de la API. El cuerpo llega sin tipar, así que cada prueba dice qué espera. */
interface Respuesta {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

const get = (ruta: string): Promise<Respuesta> =>
  fetch(`${base}${ruta}`).then(async (r) => ({ status: r.status, body: await r.json() }));

const post = (ruta: string, cuerpo: unknown = {}): Promise<Respuesta> =>
  fetch(`${base}${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

describe('arranque', () => {
  it('registra el proyecto con su nombre del fichero de configuración', () => {
    expect(app.project.name).toBe('Proyecto de prueba');
  });

  it('crea los cuatro roles del equipo', () => {
    for (const rol of ['orchestrator', 'builder', 'reviewer', 'researcher'] as const) {
      expect(agentForRole(app.db, app.project.id, rol), `falta el rol ${rol}`).toBeDefined();
    }
  });

  it('el orquestador no tiene herramientas de escritura', () => {
    const orquestador = agentForRole(app.db, app.project.id, 'orchestrator')!;
    const herramientas = JSON.parse(orquestador.allowed_tools) as string[];
    expect(herramientas).not.toContain('Write');
    expect(herramientas).not.toContain('Edit');
    expect(herramientas).not.toContain('Bash');
  });
});

describe('consulta del estado', () => {
  it('devuelve el proyecto con su equipo y su cola', async () => {
    const { status, body } = await get(`/api/projects/${app.project.id}`);
    expect(status).toBe(200);
    expect(body.project.name).toBe('Proyecto de prueba');
    // Un agente por rol: la cuenta sale de la lista de roles para que añadir uno no
    // obligue a tocar esta prueba.
    expect(body.snapshot.team).toHaveLength(AGENT_ROLES.length);
    expect(body.integrable).toEqual([]);
  });

  it('lista los agentes con el tamaño de su cola', async () => {
    const { body } = await get(`/api/projects/${app.project.id}/agents`);
    const builder = body.find((a: { role: string }) => a.role === 'builder');
    expect(builder.queue_length).toBe(0);
    expect(builder.busy_workers).toBe(0);
  });

  it('devuelve 404 en una ruta que no existe', async () => {
    expect((await get('/api/no-existe')).status).toBe(404);
  });
});

describe('chat con el orquestador', () => {
  it('guarda el mensaje del creador y responde 201', async () => {
    const { status, body } = await post(`/api/projects/${app.project.id}/chat`, {
      body: 'Añade un área de proyectos',
    });
    expect(status).toBe(201);
    expect(body.author).toBe('creator');

    const chat = await get(`/api/projects/${app.project.id}/chat`);
    expect(chat.body[0].body).toBe('Añade un área de proyectos');
  });

  it('rechaza un mensaje vacío', async () => {
    expect((await post(`/api/projects/${app.project.id}/chat`, { body: '   ' })).status).toBe(400);
  });

  it('el plan del orquestador crea las tareas que pide', async () => {
    motor.setOutcome({
      resultText: planDeOrquestador({
        project_goal: 'Tener un área de proyectos',
        tasks: [
          {
            title: 'Estructura de datos',
            goal: 'Crear las tablas',
            kind: 'build',
            role: 'builder',
            path_patterns: ['src/db/**'],
          },
          {
            title: 'Interfaz',
            goal: 'Pantalla de listado',
            kind: 'build',
            role: 'builder',
            depends_on: ['Estructura de datos'],
            path_patterns: ['web/**'],
          },
        ],
      }),
    });

    await post(`/api/projects/${app.project.id}/chat`, { body: 'Añade un área de proyectos' });
    await esperar(() => app.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }, (r) => r.n >= 2);

    const tareas = (await get(`/api/projects/${app.project.id}/tasks`)).body as Array<{
      title: string;
      status: string;
    }>;

    const estructura = tareas.find((t) => t.title === 'Estructura de datos')!;
    const interfaz = tareas.find((t) => t.title === 'Interfaz')!;

    // La primera no tiene dependencias, así que un worker ya puede haberla cogido.
    expect(['ready', 'in_progress', 'in_review', 'done']).toContain(estructura.status);
    // La segunda depende de la primera, así que no puede ejecutarse todavía.
    expect(interfaz.status).toBe('pending');
  });
});

describe('acciones sobre una tarea', () => {
  it('cambia la prioridad', async () => {
    const t = createTask(app.db, app.bus, {
      project_id: app.project.id,
      kind: 'build',
      title: 'Tarea',
      goal: 'Objetivo',
      required_role: 'builder',
      created_by: 'creator',
    });

    const { status, body } = await post(`/api/tasks/${t.id}/priority`, { priority: 10 });
    expect(status).toBe(200);
    expect(body.priority).toBe(10);
  });

  it('rechaza una prioridad fuera de rango', async () => {
    const t = createTask(app.db, app.bus, {
      project_id: app.project.id, kind: 'build', title: 'T', goal: 'G',
      required_role: 'builder', created_by: 'creator',
    });
    expect((await post(`/api/tasks/${t.id}/priority`, { priority: 500 })).status).toBe(400);
  });

  it('cancela una tarea con su motivo', async () => {
    const t = createTask(app.db, app.bus, {
      project_id: app.project.id, kind: 'build', title: 'T', goal: 'G',
      required_role: 'builder', created_by: 'creator',
    });

    const { body } = await post(`/api/tasks/${t.id}/cancel`, { reason: 'ya no hace falta' });
    expect(body.status).toBe('cancelled');
  });

  it('el detalle incluye ejecuciones, incrementos y hallazgos', async () => {
    const t = createTask(app.db, app.bus, {
      project_id: app.project.id, kind: 'build', title: 'T', goal: 'G',
      required_role: 'builder', created_by: 'creator', branch: 'task/x',
    });
    const builder = agentForRole(app.db, app.project.id, 'builder')!;
    const claim = claimTask(app.db, app.bus, {
      task_id: t.id, agent_id: builder.id, worker_id: 'w1', engine: 'claude_code',
    });
    publishIncrement(app.db, app.bus, {
      task_id: t.id, run_id: claim.run!.id, commit_sha: 'abc123',
      branch: 'task/x', message: 'incremento', files: ['a.ts'],
    });

    const { body } = await get(`/api/tasks/${t.id}`);
    expect(body.runs).toHaveLength(1);
    expect(body.increments).toHaveLength(1);
    expect(body.integrable.ready).toBe(false);
  });
});

describe('integración', () => {
  it('rechaza integrar una tarea que no está terminada', async () => {
    const t = createTask(app.db, app.bus, {
      project_id: app.project.id, kind: 'build', title: 'T', goal: 'G',
      required_role: 'builder', created_by: 'creator',
    });
    const { status, body } = await post(`/api/tasks/${t.id}/integrate`);
    expect(status).toBe(409);
    expect(body.reason).toMatch(/estado ready/);
  });
});

describe('canal de eventos en vivo', () => {
  it('entrega los eventos que ya existían y los nuevos', { timeout: 20_000 }, async () => {
    const respuesta = await fetch(`${base}/api/projects/${app.project.id}/events?since=0`);
    expect(respuesta.headers.get('content-type')).toContain('text/event-stream');

    const lector = respuesta.body!.getReader();
    const decodificador = new TextDecoder();

    createTask(app.db, app.bus, {
      project_id: app.project.id, kind: 'build', title: 'Tarea nueva', goal: 'G',
      required_role: 'builder', created_by: 'creator',
    });

    let texto = '';
    for (let i = 0; i < 20 && !texto.includes('task.created'); i++) {
      const { value, done } = await lector.read();
      if (done) break;
      texto += decodificador.decode(value);
    }

    expect(texto).toContain('task.created');
    expect(texto).toContain('Tarea nueva');
    await lector.cancel();
  });
});

/** Espera a que una condición se cumpla, comprobándola cada poco. */
async function esperar<T>(leer: () => T, cumple: (valor: T) => boolean, msMaximo = 8000): Promise<T> {
  const limite = Date.now() + msMaximo;
  for (;;) {
    const valor = leer();
    if (cumple(valor)) return valor;
    if (Date.now() > limite) throw new Error('La condición no se cumplió a tiempo.');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('abrir otra carpeta', () => {
  let otro: string;

  beforeEach(async () => {
    otro = await crearRepo();
    writeFileSync(
      join(otro, 'codehive.project.json'),
      JSON.stringify({ name: 'La otra carpeta', main_branch: 'main' }, null, 2),
    );
  });

  afterEach(() => {
    rmSync(otro, { recursive: true, force: true });
  });

  it('registra la carpeta nueva con su equipo completo', async () => {
    const r = await post('/api/projects/open', { path: otro });

    expect(r.status).toBe(200);
    expect(r.body.name).toBe('La otra carpeta');

    const agentes = await get(`/api/projects/${r.body.id}/agents`);
    expect(agentes.body).toHaveLength(AGENT_ROLES.length);
  });

  it('la carpeta anterior queda en pausa y la nueva en marcha', async () => {
    const antes = app.project.id;
    const r = await post('/api/projects/open', { path: otro });

    const proyectos = (await get('/api/projects')).body as Array<{ id: string; status: string }>;
    expect(proyectos.find((p) => p.id === antes)!.status).toBe('paused');
    expect(proyectos.find((p) => p.id === r.body.id)!.status).toBe('active');
  });

  it('el equipo pasa a repartir trabajo sobre la carpeta nueva', async () => {
    const r = await post('/api/projects/open', { path: otro });
    expect(app.supervisor.proyectoAbierto()).toBe(r.body.id);
  });

  it('volver a una carpeta ya abierta reutiliza su proyecto, no crea otro', async () => {
    const primera = await post('/api/projects/open', { path: otro });
    const segunda = await post('/api/projects/open', { path: otro });

    expect(segunda.body.id).toBe(primera.body.id);
    expect((await get('/api/projects')).body).toHaveLength(2);
  });

  it('una carpeta que no es un repositorio de Git se rechaza con un motivo claro', async () => {
    const suelta = mkdtempSync(join(tmpdir(), 'chf-suelta-'));
    try {
      const r = await post('/api/projects/open', { path: suelta });
      expect(r.status).toBe(400);
      expect(r.body.error).toContain('git init');
    } finally {
      rmSync(suelta, { recursive: true, force: true });
    }
  });

  it('una ruta que no existe se rechaza sin tocar nada', async () => {
    const r = await post('/api/projects/open', { path: join(otro, 'no-existe-esta-carpeta') });
    expect(r.status).toBe(400);
    expect(app.supervisor.proyectoAbierto()).toBe(app.project.id);
  });

  it('sin ruta no hace nada', async () => {
    expect((await post('/api/projects/open', {})).status).toBe(400);
  });
});

describe('explorador de carpetas', () => {
  it('lista las carpetas de una ruta y marca cuáles son repositorios', async () => {
    mkdirSync(join(repo, 'subcarpeta'));
    const r = await get(`/api/browse?path=${encodeURIComponent(repo)}`);

    expect(r.status).toBe(200);
    expect(r.body.path).toBe(repo);
    expect(r.body.is_git_repo).toBe(true);

    const nombres = (r.body.entries as Array<{ name: string }>).map((e) => e.name);
    expect(nombres).toContain('subcarpeta');
    // Los ficheros no aparecen: el explorador es solo de carpetas.
    expect(nombres).not.toContain('README.md');
  });

  it('desde una carpeta se puede subir a la de arriba', async () => {
    const r = await get(`/api/browse?path=${encodeURIComponent(repo)}`);
    expect(r.body.parent).not.toBeNull();

    const arriba = await get(`/api/browse?path=${encodeURIComponent(r.body.parent)}`);
    expect(arriba.status).toBe(200);
  });

  it('ofrece al menos una unidad desde la que empezar', async () => {
    const r = await get(`/api/browse?path=${encodeURIComponent(repo)}`);
    expect((r.body.roots as string[]).length).toBeGreaterThan(0);
  });

  it('una ruta que no existe devuelve 404', async () => {
    const r = await get(`/api/browse?path=${encodeURIComponent(join(repo, 'no-existe'))}`);
    expect(r.status).toBe(404);
  });

  it('dice si el equipo puede abrir el diálogo de carpetas del sistema', async () => {
    const r = await get(`/api/browse?path=${encodeURIComponent(repo)}`);
    // En Windows se ofrece el diálogo del sistema. En los demás, solo el explorador de la web.
    expect(r.body.native_picker).toBe(process.platform === 'win32');
  });
});

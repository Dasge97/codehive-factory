import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { openDatabase, type Db } from './core/db.js';
import { EventBus } from './core/events.js';
import { AGENT_ROLES, type AgentRole, type EngineName, type Project } from './shared/types.js';
import {
  createAgent,
  createProject,
  listAgents,
  listProjects,
  requireProject,
  setProjectStatus,
  sincronizarAgentes,
  updateProject,
} from './core/projects.js';
import { ENGINE_POR_ROL, ROLE_DEFAULTS, comprobarInstrucciones, instructionsFor, modeloPara } from './core/roles.js';
import { EngineRegistry } from './engines/registry.js';
import type { Engine } from './engines/types.js';
import { createApi } from './server/api.js';
import { Supervisor, recoverInterruptedRuns } from './workers/supervisor.js';
import { initRepo, isGitRepo } from './workers/git.js';

/** Contenido del fichero `codehive.project.json` que lleva cada proyecto gestionado. */
export const projectConfigSchema = z.object({
  name: z.string().min(1),
  main_branch: z.string().default('main'),
  verify_command: z.string().nullable().optional(),
  install_command: z.string().nullable().optional(),
  max_concurrent_runs: z.number().int().min(1).max(16).default(4),
  max_task_attempts: z.number().int().min(1).max(10).default(3),
  run_timeout_ms: z.number().int().min(60_000).default(900_000),
  protected_paths: z.array(z.string()).default([]),
  /**
   * Valor con el que nace el proyecto. Después se cambia con el botón de la web, y este
   * campo deja de mandar: si no, cada reinicio deshacería lo que se hubiera elegido.
   */
  use_personal_config: z.boolean().default(false),
  model: z.string().nullable().optional(),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface AppConfig {
  /** Ruta del fichero de base de datos, o ':memory:' en las pruebas. */
  dbPath: string;
  /** Ruta del repositorio que se va a gestionar. */
  repoPath: string;
  port: number;
  /** Motor único. Las pruebas lo usan para no llamar a ningún modelo. */
  engine?: Engine;
  /** Carpeta con la web compilada. Por omisión, `web-dist` junto al proceso. */
  webDir?: string;
}

export interface App {
  db: Db;
  bus: EventBus;
  engines: EngineRegistry;
  supervisor: Supervisor;
  project: Project;
  server: Server | null;
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

/** Lee la configuración del proyecto, con valores por omisión si no hay fichero. */
export function readProjectConfig(repoPath: string): ProjectConfig {
  const ruta = join(repoPath, 'codehive.project.json');
  if (!existsSync(ruta)) {
    return projectConfigSchema.parse({ name: repoPath.split(/[\\/]/).filter(Boolean).pop() ?? 'proyecto' });
  }
  return projectConfigSchema.parse(JSON.parse(readFileSync(ruta, 'utf8')));
}

/**
 * Registra un proyecto y su equipo si no existían todavía. Un proyecto ya registrado se
 * reutiliza: volver a arrancar el sistema no duplica nada.
 */
export function ensureProject(
  db: Db,
  repoPath: string,
  config: ProjectConfig,
  model?: string | null,
  motoresDisponibles?: EngineName[],
): Project {
  const existente = listProjects(db).find((p) => resolve(p.repo_path) === resolve(repoPath));
  if (existente) {
    // Los ficheros protegidos se releen en cada arranque. Son una decisión que se revisa
    // en el repositorio, no un ajuste que se toque desde la web, así que manda el fichero.
    updateProject(db, existente.id, { protected_paths: JSON.stringify(config.protected_paths) });

    // Un proyecto registrado antes de que existiera un rol no tiene ese agente. Se le
    // crea ahora: si no, el rol nuevo aparece en el código pero nunca en el equipo.
    crearAgentesQueFaltan(db, existente, model ?? config.model ?? null, motoresDisponibles);
    sincronizarAgentes(db, existente.id);
    return requireProject(db, existente.id);
  }

  const project = createProject(db, {
    name: config.name,
    repo_path: resolve(repoPath),
    main_branch: config.main_branch,
    verify_command: config.verify_command ?? null,
    install_command: config.install_command ?? null,
    max_concurrent_runs: config.max_concurrent_runs,
    max_task_attempts: config.max_task_attempts,
    run_timeout_ms: config.run_timeout_ms,
    protected_paths: config.protected_paths,
    use_personal_config: config.use_personal_config,
  });

  crearAgentesQueFaltan(db, project, model ?? config.model ?? null, motoresDisponibles);
  sincronizarAgentes(db, project.id);
  return requireProject(db, project.id);
}

/**
 * Crea un agente por cada rol que el proyecto todavía no tenga.
 *
 * Se llama tanto al registrar un proyecto nuevo como al abrir uno que ya existía. La
 * segunda es la que importa: cuando se añade un rol al sistema, los proyectos que ya
 * estaban registrados lo reciben al arrancar, sin tocar nada a mano.
 *
 * Devuelve los roles que ha creado.
 */
export function crearAgentesQueFaltan(
  db: Db,
  project: Project,
  model: string | null,
  motoresDisponibles?: EngineName[],
): AgentRole[] {
  const yaEstan = new Set(listAgents(db, project.id).map((a) => a.role));
  const creados: AgentRole[] = [];

  for (const role of AGENT_ROLES) {
    if (yaEstan.has(role)) continue;

    // El motor preferido de cada rol, o Claude Code si el preferido no está instalado.
    const preferido = ENGINE_POR_ROL[role];
    const engine =
      !motoresDisponibles || motoresDisponibles.includes(preferido) ? preferido : 'claude_code';

    createAgent(db, {
      project_id: project.id,
      name: ROLE_DEFAULTS[role].name,
      role,
      engine,
      // Sin modelo explícito, el motor coge el que tenga en sus ajustes quien arrancó el
      // sistema, y el mismo proyecto se comporta distinto en cada equipo.
      model: model ?? modeloPara(role, engine),
      // El texto que se guarda aquí es el que tenía el agente al crearlo, para dejar
      // constancia. Lo que se le manda en cada ejecución se lee de los ficheros de
      // `instrucciones/`, así que editarlos cambia su comportamiento sin recrear nada.
      instructions: instructionsFor(role),
      allowed_tools: ROLE_DEFAULTS[role].tools,
      max_workers: 1,
    });
    creados.push(role);
  }

  return creados;
}

/**
 * Deja una carpeta como la única que trabaja.
 *
 * El sistema recuerda todos los proyectos que se han abierto alguna vez, pero solo uno
 * está en marcha. Las demás carpetas quedan en pausa: lo que tengan a medio ejecutar
 * termina, no se les arranca nada nuevo, y al volver a abrirlas siguen donde estaban.
 */
export function dejarSoloEnMarcha(
  db: Db,
  bus: EventBus,
  supervisor: Supervisor,
  projectId: string,
): Project {
  for (const otro of listProjects(db)) {
    if (otro.id !== projectId && otro.status === 'active') {
      setProjectStatus(db, otro.id, 'paused');
    }
  }
  setProjectStatus(db, projectId, 'active');

  // Una ejecución que figure en marcha y no esté viva en este proceso es de una sesión
  // anterior del sistema: su proceso ya no existe y su tarea tiene que volver a la cola.
  const vivas = new Set(supervisor.activeWork().map((t) => t.run_id));
  recoverInterruptedRuns(db, bus, projectId, vivas);

  supervisor.abrirProyecto(projectId);
  return requireProject(db, projectId);
}

/**
 * Deja una carpeta lista para trabajar.
 *
 * Se puede abrir cualquier carpeta. Si no es un repositorio de Git, se crea uno con un
 * primer commit que recoge lo que haya dentro.
 *
 * El commit no es un adorno. Cada tarea trabaja en un `git worktree` sacado de la rama
 * principal, y un repositorio sin ningún commit no puede crear worktrees. Sin contenido en
 * ese commit, además, el worktree saldría vacío y el agente no vería el proyecto.
 */
async function prepararCarpeta(ruta: string, mainBranch: string): Promise<void> {
  if (await isGitRepo(ruta)) {
    // Un repositorio recién creado a mano puede no tener ningún commit todavía.
    await initRepo(ruta, mainBranch);
    return;
  }

  const creado = await initRepo(ruta, mainBranch);
  console.log(
    `${ruta} no era un repositorio de Git. Se ha creado uno en la rama ${creado.branch}` +
      `${creado.files > 0 ? ` con los ${creado.files} ficheros que había dentro` : ', vacío'}.`,
  );
}

/** Monta el sistema completo: base de datos, motor, supervisor y servidor web. */
export async function createApp(config: AppConfig): Promise<App> {
  // Cualquier carpeta sirve. Si todavía no es un repositorio de Git, se convierte en uno:
  // el sistema entero se apoya en ramas y worktrees, y no tiene sentido hacer que la
  // persona salga a la terminal para algo que se hace en dos órdenes.
  await prepararCarpeta(config.repoPath, readProjectConfig(config.repoPath).main_branch);

  // Si falta un fichero de instrucciones, es mejor no arrancar que descubrirlo a mitad de
  // una tarea, cuando ya se ha gastado una ejecución del motor.
  comprobarInstrucciones();

  const db = openDatabase(config.dbPath);
  const bus = new EventBus();

  // Con un motor dado se usa solo ese. Sin él, se detectan los que estén instalados y cada
  // agente se ejecuta con el suyo (decisión D34).
  const engines = config.engine ? new EngineRegistry([config.engine]) : EngineRegistry.detect();

  const projectConfig = readProjectConfig(config.repoPath);
  const project = ensureProject(
    db,
    config.repoPath,
    projectConfig,
    null,
    engines.available().map((m) => m.name),
  );

  const supervisor = new Supervisor(db, bus, project.id, config.engine ?? engines);

  /**
   * Abre una carpeta del disco y la deja como el proyecto en marcha.
   *
   * Registra la carpeta si es la primera vez que se abre, y la reutiliza si ya estaba:
   * volver a una carpeta anterior recupera su equipo, sus tareas y su conversación.
   */
  async function abrirCarpeta(ruta: string): Promise<Project> {
    const destino = resolve(ruta);

    if (!existsSync(destino)) {
      throw new Error(`La carpeta ${destino} no existe.`);
    }

    const configuracion = readProjectConfig(destino);
    await prepararCarpeta(destino, configuracion.main_branch);

    const abierto = ensureProject(
      db,
      destino,
      configuracion,
      null,
      engines.available().map((m) => m.name),
    );
    return dejarSoloEnMarcha(db, bus, supervisor, abierto.id);
  }

  // Al arrancar, la carpeta indicada al lanzar el sistema es la que queda abierta.
  dejarSoloEnMarcha(db, bus, supervisor, project.id);

  const api = createApi({
    db,
    bus,
    supervisor,
    engines,
    abrirCarpeta,
    webDir: config.webDir ?? join(process.cwd(), 'web-dist'),
  });

  let server: Server | null = null;

  return {
    db,
    bus,
    engines,
    supervisor,
    project,
    get server() {
      return server;
    },

    async start() {
      const comprobaciones = await engines.check();
      const utilizables = comprobaciones.filter((c) => c.ok);

      if (utilizables.length === 0) {
        const motivos = [
          ...comprobaciones.map((c) => `${c.engine}: ${c.error}`),
          ...engines.unavailable().map((u) => `${u.engine}: ${u.reason}`),
        ];
        throw new Error(['No hay ningún motor disponible.', ...motivos].join('\n'));
      }

      for (const c of utilizables) {
        console.log(`Motor listo: ${c.engine} ${c.version ?? ''}`.trim());
      }
      for (const u of engines.unavailable()) {
        console.log(`Motor no disponible: ${u.engine}. ${u.reason}`);
      }

      server = createServer(api);
      const puerto = await new Promise<number>((resolver, rechazar) => {
        server!.once('error', rechazar);
        // Escucha en todas las interfaces para poder abrir la web desde el móvil por la
        // dirección IP del equipo en la red local (decisión D06).
        server!.listen(config.port, '0.0.0.0', () => {
          const direccion = server!.address();
          resolver(typeof direccion === 'object' && direccion ? direccion.port : config.port);
        });
      });

      supervisor.start();
      return { port: puerto };
    },

    async stop() {
      await supervisor.stop();
      if (server) {
        // Las conexiones del canal de eventos se quedan abiertas a propósito mientras la
        // web mira, así que hay que cerrarlas o el servidor nunca termina de pararse.
        server.closeAllConnections();
        await new Promise<void>((resolver) => server!.close(() => resolver()));
        server = null;
      }
      db.close();
    },
  };
}

/** Agentes configurados en un proyecto. Se usa al arrancar para informar por consola. */
export function describeTeam(db: Db, projectId: string): string {
  return listAgents(db, projectId)
    .map((a) => `${a.name} (${a.role}) con ${a.engine}`)
    .join(', ');
}

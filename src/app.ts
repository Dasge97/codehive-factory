import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { openDatabase, type Db } from './core/db.js';
import { EventBus } from './core/events.js';
import { AGENT_ROLES, type AgentRole, type Project } from './shared/types.js';
import { createAgent, createProject, listAgents, listProjects } from './core/projects.js';
import { ROLE_DEFAULTS, instructionsFor } from './core/roles.js';
import { ClaudeCodeEngine } from './engines/claude-code.js';
import type { Engine } from './engines/types.js';
import { createApi } from './server/api.js';
import { Supervisor, recoverInterruptedRuns } from './workers/supervisor.js';
import { isGitRepo } from './workers/git.js';

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
  model: z.string().nullable().optional(),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface AppConfig {
  /** Ruta del fichero de base de datos, o ':memory:' en las pruebas. */
  dbPath: string;
  /** Ruta del repositorio que se va a gestionar. */
  repoPath: string;
  port: number;
  engine?: Engine;
  /** Carpeta con la web compilada. Por omisión, `web-dist` junto al proceso. */
  webDir?: string;
}

export interface App {
  db: Db;
  bus: EventBus;
  engine: Engine;
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
export function ensureProject(db: Db, repoPath: string, config: ProjectConfig, model?: string | null): Project {
  const existente = listProjects(db).find((p) => resolve(p.repo_path) === resolve(repoPath));
  if (existente) return existente;

  const project = createProject(db, {
    name: config.name,
    repo_path: resolve(repoPath),
    main_branch: config.main_branch,
    verify_command: config.verify_command ?? null,
    install_command: config.install_command ?? null,
    max_concurrent_runs: config.max_concurrent_runs,
    max_task_attempts: config.max_task_attempts,
    run_timeout_ms: config.run_timeout_ms,
  });

  for (const role of AGENT_ROLES) {
    createAgent(db, {
      project_id: project.id,
      name: ROLE_DEFAULTS[role as AgentRole].name,
      role: role as AgentRole,
      engine: 'claude_code',
      model: model ?? config.model ?? null,
      instructions: instructionsFor(role as AgentRole),
      allowed_tools: ROLE_DEFAULTS[role as AgentRole].tools,
      max_workers: 1,
    });
  }

  return project;
}

/** Monta el sistema completo: base de datos, motor, supervisor y servidor web. */
export async function createApp(config: AppConfig): Promise<App> {
  if (!(await isGitRepo(config.repoPath))) {
    throw new Error(`${config.repoPath} no es un repositorio de Git. Ejecuta git init antes de registrarlo.`);
  }

  const db = openDatabase(config.dbPath);
  const bus = new EventBus();
  const engine = config.engine ?? ClaudeCodeEngine.create();

  const projectConfig = readProjectConfig(config.repoPath);
  const project = ensureProject(db, config.repoPath, projectConfig);

  // Al arrancar no puede quedar ninguna ejecución en marcha: sus procesos ya no existen.
  const recuperadas = recoverInterruptedRuns(db, bus, project.id);
  if (recuperadas > 0) {
    console.log(`Se han devuelto a la cola ${recuperadas} tareas que quedaron a medias.`);
  }

  const supervisor = new Supervisor(db, bus, project.id, engine);
  const api = createApi({ db, bus, supervisor, webDir: config.webDir ?? join(process.cwd(), 'web-dist') });

  let server: Server | null = null;

  return {
    db,
    bus,
    engine,
    supervisor,
    project,
    get server() {
      return server;
    },

    async start() {
      const comprobacion = await engine.check();
      if (!comprobacion.ok) {
        throw new Error(`El motor no está disponible: ${comprobacion.error}`);
      }
      console.log(`Motor listo: ${engine.name} ${comprobacion.version ?? ''}`.trim());

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

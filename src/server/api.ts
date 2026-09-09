import express, { type Express, type Request, type Response } from 'express';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { Db } from '../core/db.js';
import { EventBus, listEvents, listRecentEvents } from '../core/events.js';
import { integrableTasks, integrateTask } from '../core/integration.js';
import { listChat, listChatDeConversacion, postChatMessage, projectSnapshot } from '../core/orchestrator.js';
import { abrirConversacion, listarConversaciones, nuevaConversacion } from '../core/conversations.js';
import {
  listAgents,
  listProjects,
  requireProject,
  setAgentEnabled,
  setAgentEngine,
  setAgentWorkers,
  setProjectMode,
  setProjectPersonalConfig,
  setProjectStatus,
  updateProject,
} from '../core/projects.js';
import { queueForRole, razonDeEspera } from '../core/queue.js';
import { listarTurnos, resumenDeTurnos } from '../core/orchestrator-turns.js';
import { listFindings, listIncrements, readyToIntegrate } from '../core/review.js';
import { RuleError, addNotice, listTasks, requireTask, setPriority, setStatus } from '../core/tasks.js';
import { abandonarLimpieza } from '../workers/runner.js';
import { now } from '../shared/ids.js';
import {
  ENGINES,
  PROJECT_MODES,
  type Approval,
  type EngineName,
  type Project,
  type ProjectMode,
  type Run,
  type Task,
} from '../shared/types.js';
import type { Supervisor } from '../workers/supervisor.js';
import type { EngineRegistry } from '../engines/registry.js';
import { elegirCarpetaNativa, haySelectorNativo } from './selector-carpeta.js';

export interface ApiDeps {
  db: Db;
  bus: EventBus;
  supervisor: Supervisor;
  /** Motores disponibles. Sirve para no dejar configurar uno que no está instalado. */
  engines?: EngineRegistry;
  /** Abre una carpeta del disco y la deja como el proyecto en marcha. */
  abrirCarpeta?: (ruta: string) => Promise<Project>;
  /** Carpeta con la web ya compilada. Si no existe, el servidor solo ofrece la API. */
  webDir?: string;
}

/** Lee un parámetro de la ruta como texto. Express 5 los tipa de forma más laxa. */
function param(req: Request, nombre: string): string {
  const valor = (req.params as Record<string, unknown>)[nombre];
  return Array.isArray(valor) ? String(valor[0]) : String(valor ?? '');
}

/** Envuelve un manejador asíncrono para que un fallo llegue al manejador de errores. */
function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((e) => {
      const codigo = e instanceof RuleError ? 400 : 500;
      res.status(codigo).json({ error: e instanceof Error ? e.message : String(e) });
    });
  };
}

export function createApi({ db, bus, supervisor, engines, abrirCarpeta, webDir }: ApiDeps): Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // -------------------------------------------------------------------------
  // Proyectos
  // -------------------------------------------------------------------------

  app.get('/api/projects', (_req, res) => {
    res.json(listProjects(db));
  });

  /**
   * Abre una carpeta del disco. Es el equivalente a cambiar de carpeta en el editor: a
   * partir de aquí el equipo trabaja sobre ella y la anterior queda en pausa.
   */
  app.post(
    '/api/projects/open',
    asyncHandler(async (req, res) => {
      if (!abrirCarpeta) {
        res.status(501).json({ error: 'Este servicio no puede abrir carpetas.' });
        return;
      }

      const ruta = String(req.body?.path ?? '').trim();
      if (!ruta) {
        res.status(400).json({ error: 'Falta la ruta de la carpeta.' });
        return;
      }

      try {
        res.json(await abrirCarpeta(ruta));
      } catch (e) {
        // No poder abrir una carpeta es una respuesta normal, no un fallo del servicio: la
        // ruta no existe, o no se puede leer.
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  /**
   * Lista las carpetas que hay dentro de una ruta, para poder elegir cuál abrir.
   *
   * Solo devuelve nombres de carpetas, nunca el contenido de un fichero. Marca cuáles son
   * repositorios de Git, que son las únicas que se pueden abrir.
   */
  /**
   * Abre el diálogo de carpetas del sistema y devuelve la que se elija.
   *
   * La ventana aparece en el equipo donde corre el servicio, no en el que mira la web. Por
   * eso el explorador de la web sigue estando: desde el móvil es la única forma.
   */
  app.post(
    '/api/browse/native',
    asyncHandler(async (req, res) => {
      if (!haySelectorNativo()) {
        res.status(501).json({ error: 'Este equipo no puede abrir el diálogo de carpetas del sistema.' });
        return;
      }

      try {
        const elegida = await elegirCarpetaNativa(String(req.body?.path ?? '').trim() || undefined);
        res.json({ path: elegida, cancelled: elegida === null });
      } catch (e) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  app.get('/api/browse', (req, res) => {
    const pedida = String(req.query['path'] ?? '').trim();
    const actual = resolve(pedida || homedir());

    if (!existsSync(actual)) {
      res.status(404).json({ error: `La carpeta ${actual} no existe.` });
      return;
    }

    let entradas: Array<{ name: string; path: string; is_git_repo: boolean }> = [];
    try {
      entradas = readdirSync(actual, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const ruta = join(actual, e.name);
          return { name: e.name, path: ruta, is_git_repo: existsSync(join(ruta, '.git')) };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    } catch (e) {
      res.status(403).json({ error: `No se puede leer ${actual}: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }

    const padre = dirname(actual);

    res.json({
      path: actual,
      // En la raíz de una unidad, `dirname` devuelve la misma ruta. No hay a dónde subir.
      parent: padre === actual ? null : padre,
      is_git_repo: existsSync(join(actual, '.git')),
      entries: entradas,
      roots: unidades(),
      // La web solo ofrece el botón del diálogo del sistema si el equipo puede abrirlo.
      native_picker: haySelectorNativo(),
    });
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = requireProject(db, req.params.id);
    const uso = db.prepare('SELECT * FROM engine_usage').all();

    res.json({
      project,
      snapshot: projectSnapshot(db, project.id),
      integrable: integrableTasks(db, project.id),
      usage: uso,
      active_work: supervisor.activeWork(),
    });
  });

  app.get('/api/projects/:id/tasks', (req, res) => {
    const projectId = req.params.id;
    const estado = req.query['status'] as Task['status'] | undefined;
    const tareas = listTasks(db, projectId, estado ? { status: estado } : {});

    res.json(
      tareas.map((t) => ({
        ...t,
        waiting_for: t.status === 'ready' ? razonDeEspera(db, t.id) : null,
        findings_open: listFindings(db, t.id).filter((f) => f.status === 'open').length,
      })),
    );
  });

  app.get('/api/projects/:id/agents', (req, res) => {
    const activos = supervisor.activeWork();
    res.json(
      listAgents(db, req.params.id).map((a) => {
        const suyos = activos.filter((t) => t.agent_id === a.id);
        return {
          ...a,
          allowed_tools: JSON.parse(a.allowed_tools),
          busy_workers: suyos.length,
          current_tasks: suyos.map((t) => t.task_id),
          queue_length: queueForRole(db, req.params.id, a.role).length,
        };
      }),
    );
  });

  app.post('/api/projects/:id/settings', (req, res) => {
    const cuerpo = req.body ?? {};
    const cambios: Record<string, unknown> = {};

    if (typeof cuerpo.goal === 'string') cambios['goal'] = cuerpo.goal;
    if (typeof cuerpo.verify_command === 'string' || cuerpo.verify_command === null) {
      cambios['verify_command'] = cuerpo.verify_command;
    }
    if (typeof cuerpo.install_command === 'string' || cuerpo.install_command === null) {
      cambios['install_command'] = cuerpo.install_command;
    }
    for (const [campo, minimo, maximo] of [
      ['max_concurrent_runs', 1, 16],
      ['max_task_attempts', 1, 10],
    ] as Array<[string, number, number]>) {
      const valor = cuerpo[campo];
      if (valor === undefined) continue;
      if (!Number.isInteger(valor) || valor < minimo || valor > maximo) {
        res.status(400).json({ error: `${campo} debe ser un entero entre ${minimo} y ${maximo}.` });
        return;
      }
      cambios[campo] = valor;
    }
    if (cuerpo.run_timeout_ms !== undefined) {
      if (!Number.isInteger(cuerpo.run_timeout_ms) || cuerpo.run_timeout_ms < 60_000) {
        res.status(400).json({ error: 'El tiempo máximo de una ejecución no puede bajar de 60000 ms.' });
        return;
      }
      cambios['run_timeout_ms'] = cuerpo.run_timeout_ms;
    }

    res.json(updateProject(db, param(req, 'id'), cambios));
  });

  app.post('/api/projects/:id/pause', (req, res) => {
    // Un proyecto en pausa conserva su trabajo: el supervisor deja de arrancar workers y
    // las tareas se quedan donde están.
    const pausar = req.body?.paused !== false;
    res.json(setProjectStatus(db, param(req, 'id'), pausar ? 'paused' : 'active'));
  });

  app.get('/api/projects/:id/orchestrator/turns', (req, res) => {
    res.json({
      resumen: resumenDeTurnos(db, req.params.id),
      turnos: listarTurnos(db, req.params.id, 20),
    });
  });

  app.post('/api/projects/:id/mode', (req, res) => {
    const mode = String(req.body?.mode ?? '');
    if (!(PROJECT_MODES as readonly string[]).includes(mode)) {
      res.status(400).json({ error: `El modo debe ser uno de: ${PROJECT_MODES.join(', ')}.` });
      return;
    }

    // El cambio vale para las tareas que se creen desde ahora. Las que ya están en marcha
    // terminan con las reglas con las que empezaron.
    res.json(setProjectMode(db, param(req, 'id'), mode as ProjectMode));
  });

  app.post('/api/projects/:id/personal-config', (req, res) => {
    // El cambio vale para las ejecuciones que empiecen a partir de ahora. Una ejecución en
    // marcha termina con la configuración con la que arrancó.
    const usar = req.body?.use_personal_config === true;
    res.json(setProjectPersonalConfig(db, param(req, 'id'), usar));
  });

  app.post('/api/projects/:id/orchestrator/stop', (_req, res) => {
    // Pedir la parada no significa que ya esté parado: el motor tarda en cerrarse, y la
    // web enseña la parada como solicitada hasta que llega la confirmación.
    res.json({ requested: true, running: supervisor.stopOrchestrator() });
  });

  app.get('/api/projects/:id/chat', (req, res) => {
    // Con `conversation` se pide una conversación concreta; sin él, la que está abierta.
    const pedida = String(req.query['conversation'] ?? '').trim();
    res.json(pedida ? listChatDeConversacion(db, pedida) : listChat(db, req.params.id));
  });

  app.get('/api/projects/:id/conversations', (req, res) => {
    res.json(listarConversaciones(db, req.params.id));
  });

  app.post('/api/projects/:id/conversations', (req, res) => {
    // Una conversación en blanco. El orquestador solo ve la abierta, así que a partir de
    // aquí deja de tener delante lo hablado antes. Las tareas y el trabajo no se tocan.
    res.status(201).json(nuevaConversacion(db, param(req, 'id')));
  });

  app.post('/api/projects/:id/conversations/:conversationId/open', (req, res) => {
    res.json(abrirConversacion(db, param(req, 'id'), param(req, 'conversationId')));
  });

  app.post('/api/projects/:id/chat', (req, res) => {
    const cuerpo = String(req.body?.body ?? '').trim();
    if (!cuerpo) {
      res.status(400).json({ error: 'El mensaje está vacío.' });
      return;
    }

    const mensaje = postChatMessage(db, bus, req.params.id, 'creator', cuerpo);
    supervisor.requestOrchestratorTurn();
    res.status(201).json(mensaje);
  });

  // -------------------------------------------------------------------------
  // Agentes
  // -------------------------------------------------------------------------

  app.post('/api/agents/:id/engine', (req, res) => {
    const engine = String(req.body?.engine ?? '');
    if (!(ENGINES as readonly string[]).includes(engine)) {
      res.status(400).json({ error: `El motor debe ser uno de: ${ENGINES.join(', ')}.` });
      return;
    }

    const motor = engines?.get(engine as EngineName);
    if (engines && !motor) {
      res.status(400).json({ error: `El motor ${engine} no está instalado en este equipo.` });
      return;
    }

    res.json(setAgentEngine(db, param(req, 'id'), engine as EngineName));
  });

  app.post('/api/agents/:id/enabled', (req, res) => {
    res.json(setAgentEnabled(db, param(req, 'id'), req.body?.enabled !== false));
  });

  app.post('/api/agents/:id/workers', (req, res) => {
    const workers = Number(req.body?.max_workers);
    if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
      res.status(400).json({ error: 'El número de workers debe ser un entero entre 1 y 8.' });
      return;
    }
    res.json(setAgentWorkers(db, param(req, 'id'), workers));
  });

  app.get('/api/engines', (_req, res) => {
    res.json({
      available: (engines?.available() ?? []).map((m) => ({ name: m.name, capabilities: m.capabilities() })),
      unavailable: engines?.unavailable() ?? [],
    });
  });

  // -------------------------------------------------------------------------
  // Tareas
  // -------------------------------------------------------------------------

  app.get('/api/tasks/:id', (req, res) => {
    const task = requireTask(db, req.params.id);
    const ejecuciones = db
      .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC')
      .all(task.id) as Run[];

    res.json({
      task,
      waiting_for: task.status === 'ready' ? razonDeEspera(db, task.id) : null,
      runs: ejecuciones,
      increments: listIncrements(db, task.id),
      findings: listFindings(db, task.id),
      integrable: readyToIntegrate(db, task.id),
      approvals: db.prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at DESC').all(task.id),
      notices: db.prepare('SELECT * FROM notices WHERE task_id = ? ORDER BY created_at').all(task.id),
      dependencies: db
        .prepare(
          `SELECT t.id, t.title, t.status FROM task_dependencies d
           JOIN tasks t ON t.id = d.depends_on_id WHERE d.task_id = ?`,
        )
        .all(task.id),
      locks: db.prepare('SELECT * FROM resource_locks WHERE task_id = ?').all(task.id),
    });
  });

  app.post('/api/tasks/:id/priority', (req, res) => {
    const prioridad = Number(req.body?.priority);
    if (!Number.isInteger(prioridad) || prioridad < 1 || prioridad > 100) {
      res.status(400).json({ error: 'La prioridad debe ser un número entero entre 1 y 100.' });
      return;
    }
    res.json(setPriority(db, bus, req.params.id, prioridad));
  });

  app.post(
    '/api/tasks/:id/cancel',
    asyncHandler(async (req, res) => {
      const motivo = String(req.body?.reason ?? 'cancelada por el creador');
      const cancelada = setStatus(db, bus, param(req, 'id'), 'cancelled', motivo);
      // Cancelar una limpieza no deja colgado al trabajo que la esperaba.
      if (cancelada.kind === 'refactor') await abandonarLimpieza(db, bus, cancelada.id);
      res.json(cancelada);
    }),
  );

  /**
   * Devuelve a la cola una tarea bloqueada. Es lo que hace el creador cuando ha resuelto
   * lo que la bloqueaba: una autorización, una decisión o un fichero que faltaba.
   */
  app.post('/api/tasks/:id/reopen', (req, res) => {
    const tarea = requireTask(db, param(req, 'id'));
    if (tarea.status !== 'blocked') {
      res.status(400).json({ error: `La tarea no está bloqueada, está en ${tarea.status}.` });
      return;
    }
    const motivo = String(req.body?.reason ?? '').trim() || 'reabierta por el creador';
    addNotice(db, tarea.id, 'creator', `Se reabre: ${motivo}`);
    res.json(setStatus(db, bus, tarea.id, 'ready', motivo));
  });

  app.post(
    '/api/tasks/:id/integrate',
    asyncHandler(async (req, res) => {
      const resultado = await integrateTask(db, bus, param(req, 'id'));
      res.status(resultado.integrated ? 200 : 409).json(resultado);
    }),
  );

  // -------------------------------------------------------------------------
  // Ejecuciones y autorizaciones
  // -------------------------------------------------------------------------

  app.post('/api/runs/:id/stop', (req, res) => {
    const detenida = supervisor.stopRun(req.params.id);
    // Pedir una parada no significa que la ejecución ya esté detenida: el estado real
    // llega cuando el worker confirma (documento 08, apartado 8.8).
    res.json({ requested: true, found: detenida });
  });

  app.post('/api/approvals/:id', (req, res) => {
    const conceder = req.body?.granted === true;
    const aprobacion = db.prepare('SELECT * FROM approvals WHERE id = ?').get(req.params.id) as Approval | undefined;
    if (!aprobacion) {
      res.status(404).json({ error: 'La autorización no existe.' });
      return;
    }

    db.prepare('UPDATE approvals SET status = ?, responded_by = ?, responded_at = ? WHERE id = ?').run(
      conceder ? 'granted' : 'denied',
      'creator',
      now(),
      req.params.id,
    );

    const task = requireTask(db, aprobacion.task_id);
    bus.emitEvent({
      id: -1,
      project_id: task.project_id,
      type: 'approval.resolved',
      task_id: task.id,
      run_id: aprobacion.run_id,
      agent_id: null,
      payload: JSON.stringify({ approval_id: req.params.id, granted: conceder }),
      created_at: now(),
    });

    res.json({ ...aprobacion, status: conceder ? 'granted' : 'denied' });
  });

  // -------------------------------------------------------------------------
  // Eventos en vivo
  // -------------------------------------------------------------------------

  app.get('/api/projects/:id/events', (req, res) => {
    const projectId = req.params.id;
    const ultimoRecibido = req.headers['last-event-id'];
    const desde =
      Number(req.query['since'] ?? (Array.isArray(ultimoRecibido) ? ultimoRecibido[0] : ultimoRecibido) ?? 0) || 0;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Enviar las cabeceras ya, sin esperar al primer evento: el cliente necesita saber
    // que la conexión está abierta aunque todavía no haya nada que contar.
    res.flushHeaders();
    res.write(': conectado\n\n');

    // Al reconectar, la web pide desde el último evento que recibió y no pierde nada.
    for (const evento of listEvents(db, projectId, { sinceId: desde, limit: 500 })) {
      escribirEvento(res, evento.id, evento);
    }

    const desuscribir = bus.onProject(projectId, (evento) => {
      escribirEvento(res, evento.id, evento);
    });

    // Un comentario cada veinte segundos mantiene viva la conexión a través de servidores
    // intermedios que cortan las conexiones inactivas.
    const latido = setInterval(() => res.write(': latido\n\n'), 20_000);

    req.on('close', () => {
      clearInterval(latido);
      desuscribir();
    });
  });

  app.get('/api/projects/:id/activity', (req, res) => {
    res.json(listRecentEvents(db, req.params.id, Number(req.query['limit'] ?? 50)));
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada.' });
  });

  // La web compilada se sirve desde el mismo proceso, así que basta con abrir el puerto
  // del servicio para tenerla (decisión D06).
  if (webDir && existsSync(webDir)) {
    app.use(express.static(webDir));
    app.get(/.*/, (_req, res) => {
      res.sendFile(join(webDir, 'index.html'));
    });
  } else {
    app.use((_req, res) => {
      res.status(404).json({
        error: 'La web no está compilada. Ejecuta npm run build:web, o npm run dev:web para desarrollo.',
      });
    });
  }

  return app;
}

/**
 * Unidades del equipo, para poder saltar de una a otra desde el explorador.
 *
 * En Windows no hay una raíz única desde la que se llegue a todo, así que se comprueba
 * letra por letra cuáles existen. En los demás sistemas, la raíz es una sola.
 */
function unidades(): string[] {
  if (process.platform !== 'win32') return ['/'];

  const encontradas: string[] = [];
  for (let letra = 'A'.charCodeAt(0); letra <= 'Z'.charCodeAt(0); letra++) {
    const unidad = `${String.fromCharCode(letra)}:${sep}`;
    try {
      if (statSync(unidad).isDirectory()) encontradas.push(unidad);
    } catch {
      // La unidad no existe o no está lista. No es un error: simplemente no se ofrece.
    }
  }
  return encontradas;
}

function escribirEvento(res: Response, id: number, evento: unknown): void {
  if (id >= 0) res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(evento)}\n\n`);
}

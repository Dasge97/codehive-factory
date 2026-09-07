import type { Db } from '../core/db.js';
import { EventBus, appendEvent } from '../core/events.js';
import { agentTools, listAgents, requireProject } from '../core/projects.js';
import { instructionsFor } from '../core/roles.js';
import { claimNext, queueForRole } from '../core/queue.js';
import {
  ORCHESTRATOR_PLAN_JSON_SCHEMA,
  applyPlan,
  orchestratorPlanSchema,
  postChatMessage,
  projectSnapshot,
  renderOrchestratorPrompt,
} from '../core/orchestrator.js';
import { requireTask } from '../core/tasks.js';
import { LEASE_RENEW_MS, reclaimExpiredLeases, renewLease } from '../core/leases.js';
import { newId } from '../shared/ids.js';
import type { Agent, AgentRole } from '../shared/types.js';
import type { Engine, EngineHandle } from '../engines/types.js';
import type { EngineRegistry } from '../engines/registry.js';
import { runTask, saveUsage } from './runner.js';

/** Una ejecución en marcha, con lo justo para poder pararla. */
interface TrabajoActivo {
  worker_id: string;
  agent_id: string;
  role: AgentRole;
  task_id: string;
  run_id: string;
  handle?: EngineHandle;
  /** Se resuelve cuando la ejecución termina. Parar espera a todas. */
  terminado?: Promise<void>;
}

export interface SupervisorOptions {
  /** Cada cuánto se mira si hay trabajo, en milisegundos. */
  intervalMs?: number;
  /** Cada cuánto se renueva la vigencia de las asignaciones en marcha. */
  leaseRenewMs?: number;
  /** Cuánto vale una asignación antes de darse por perdida. */
  leaseTtlMs?: number;
}

/**
 * Decide cuándo hay trabajo y lo pone en marcha.
 *
 * No arranca nada para tener a los agentes ocupados: un worker se activa solo cuando hay
 * una tarea que puede reclamar. Con la cola vacía, el sistema no consume nada.
 */
export class Supervisor {
  private readonly activos = new Map<string, TrabajoActivo>();
  private temporizador: NodeJS.Timeout | null = null;
  private turnoOrquestadorPendiente = false;
  private turnoOrquestador: Promise<void> | null = null;
  private handleOrquestador: EngineHandle | null = null;
  private renovacion: NodeJS.Timeout | null = null;
  private parando = false;

  private readonly registry: EngineRegistry | null;
  private readonly engine: Engine | null;

  /**
   * Recibe un motor único o un registro con varios. Con un registro, cada agente se
   * ejecuta con el motor que tenga configurado (decisión D34).
   */
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private projectId: string,
    engineOrRegistry: Engine | EngineRegistry,
    private readonly options: SupervisorOptions = {},
  ) {
    if ('require' in engineOrRegistry) {
      this.registry = engineOrRegistry;
      this.engine = null;
    } else {
      this.registry = null;
      this.engine = engineOrRegistry;
    }
  }

  /**
   * Cambia el proyecto sobre el que se reparte trabajo.
   *
   * Lo que ya está en marcha sigue hasta terminar y se guarda donde corresponde: cada
   * ejecución lleva su tarea, y su tarea lleva su proyecto. Lo único que cambia es de
   * dónde salen las tareas nuevas.
   */
  abrirProyecto(projectId: string): void {
    this.projectId = projectId;
    // Un turno pedido para el proyecto anterior no se traslada al nuevo: el mensaje que lo
    // provocó era de otra conversación.
    this.turnoOrquestadorPendiente = false;
    if (!this.parando) void this.tick();
  }

  /** Proyecto sobre el que se está repartiendo trabajo ahora mismo. */
  proyectoAbierto(): string {
    return this.projectId;
  }

  /** Motor con el que se ejecuta un agente. */
  private motorDe(agent: Agent): Engine {
    if (this.engine) return this.engine;
    return this.registry!.require(agent.engine);
  }

  /** Motores en uso, para las comprobaciones que no dependen de un agente concreto. */
  private motores(): Engine[] {
    return this.engine ? [this.engine] : this.registry!.available();
  }

  start(): void {
    if (this.temporizador) return;
    this.parando = false;
    const intervalo = this.options.intervalMs ?? 2000;
    this.temporizador = setInterval(() => void this.tick(), intervalo);

    // Renovar la vigencia de lo que está en marcha va por su propio reloj: si dependiera
    // del ciclo de reparto, un ciclo lento daría por perdidos a workers que están vivos.
    const cadencia = this.options.leaseRenewMs ?? LEASE_RENEW_MS;
    this.renovacion = setInterval(() => this.renovarVigencias(), cadencia);

    void this.tick();
  }

  /** Renueva la vigencia de cada trabajo en marcha. */
  private renovarVigencias(): void {
    for (const trabajo of this.activos.values()) {
      renewLease(this.db, trabajo.task_id, trabajo.run_id, trabajo.worker_id, this.options.leaseTtlMs);
    }
  }

  /**
   * Deja de arrancar trabajo nuevo, detiene lo que esté en marcha y espera a que termine.
   *
   * Esperar es imprescindible: un trabajo en vuelo sigue escribiendo en la base de datos,
   * y si se cierra antes de tiempo el proceso falla con la conexión ya cerrada.
   */
  async stop(): Promise<void> {
    this.parando = true;
    if (this.temporizador) {
      clearInterval(this.temporizador);
      this.temporizador = null;
    }
    if (this.renovacion) {
      clearInterval(this.renovacion);
      this.renovacion = null;
    }

    this.handleOrquestador?.stop();
    for (const trabajo of this.activos.values()) {
      trabajo.handle?.stop();
    }

    const pendientes = [...this.activos.values()].map((t) => t.terminado).filter(Boolean) as Promise<void>[];
    if (this.turnoOrquestador) pendientes.push(this.turnoOrquestador);
    await Promise.allSettled(pendientes);
  }

  /** Pide que el orquestador tome un turno en cuanto pueda. */
  requestOrchestratorTurn(): void {
    this.turnoOrquestadorPendiente = true;
    void this.tick();
  }

  /** Qué está haciendo ahora mismo cada worker. */
  activeWork(): TrabajoActivo[] {
    return [...this.activos.values()];
  }

  /** 
   * Para el turno del orquestador si lo hay.
   *
   * Pedir la parada no significa que ya esté parado: el motor tarda en cerrarse, y hasta
   * que confirma, la web dice que la parada está solicitada.
   */
  stopOrchestrator(): boolean {
    if (!this.handleOrquestador) return false;
    this.handleOrquestador.stop();
    return true;
  }

  /** Verdadero mientras el orquestador tiene un turno en marcha. */
  orchestratorBusy(): boolean {
    return this.turnoOrquestador !== null;
  }

  /** Detiene una ejecución concreta. */
  stopRun(runId: string): boolean {
    for (const trabajo of this.activos.values()) {
      if (trabajo.run_id === runId) {
        trabajo.handle?.stop();
        return true;
      }
    }
    return false;
  }

  private async tick(): Promise<void> {
    if (this.parando) return;

    // El proyecto abierto puede cambiar mientras esto corre, así que se lee una vez y se
    // usa el mismo hasta el final del ciclo.
    const projectId = this.projectId;
    const project = requireProject(this.db, projectId);
    if (project.status !== 'active') return;

    if (this.todosSinCuota()) return;

    // Antes de repartir trabajo nuevo se recupera el de los workers que se perdieron.
    reclaimExpiredLeases(this.db, this.bus, projectId);

    if (this.turnoOrquestadorPendiente && !this.turnoOrquestador) {
      this.turnoOrquestadorPendiente = false;
      this.turnoOrquestador = this.runOrchestratorTurn().finally(() => {
        this.turnoOrquestador = null;
        if (!this.parando) void this.tick();
      });
    }

    if (this.activos.size >= project.max_concurrent_runs) return;

    for (const agent of listAgents(this.db, projectId)) {
      if (agent.role === 'orchestrator' || !agent.enabled) continue;
      if (this.activos.size >= project.max_concurrent_runs) break;
      if (this.ocupadosDe(agent.id) >= agent.max_workers) continue;
      if (queueForRole(this.db, projectId, agent.role).length === 0) continue;
      // Un agente cuyo motor se quedó sin cuota espera; los demás siguen trabajando.
      if (this.sinCuota(agent.engine)) continue;

      this.arrancarWorker(projectId, agent);
    }
  }

  private ocupadosDe(agentId: string): number {
    let n = 0;
    for (const trabajo of this.activos.values()) if (trabajo.agent_id === agentId) n++;
    return n;
  }

  /**
   * Con el motor sin cuota, no se arranca nada. Sus tareas quedan como estén y conservan
   * su estado hasta que el creador decida reanudar (decisión D18).
   */
  private sinCuota(engine: string): boolean {
    const uso = this.db
      .prepare('SELECT status FROM engine_usage WHERE engine = ?')
      .get(engine) as { status: string } | undefined;
    return uso?.status === 'exhausted' || uso?.status === 'rejected';
  }

  /** Verdadero cuando ningún motor tiene cuota. */
  private todosSinCuota(): boolean {
    return this.motores().every((m) => this.sinCuota(m.name));
  }

  private arrancarWorker(projectId: string, agent: Agent): void {
    let motor: Engine;
    try {
      motor = this.motorDe(agent);
    } catch (e) {
      // El agente está configurado con un motor que no está instalado.
      appendEvent(this.db, this.bus, {
        project_id: projectId,
        type: 'quota.exhausted',
        agent_id: agent.id,
        payload: { engine: agent.engine, reason: e instanceof Error ? e.message : String(e) },
      });
      return;
    }

    const workerId = newId('worker');
    const claim = claimNext(this.db, this.bus, projectId, agent.role, {
      agent_id: agent.id,
      worker_id: workerId,
      engine: motor.name,
    });
    if (!claim.claimed || !claim.run || !claim.task) return;

    const trabajo: TrabajoActivo = {
      worker_id: workerId,
      agent_id: agent.id,
      role: agent.role,
      task_id: claim.task.id,
      run_id: claim.run.id,
    };
    this.activos.set(workerId, trabajo);

    trabajo.terminado = runTask(this.db, this.bus, {
      task: claim.task,
      agent,
      run: claim.run,
      engine: motor,
    })
      .then(() => undefined)
      .catch((e) => {
        appendEvent(this.db, this.bus, {
          project_id: projectId,
          type: 'run.finished',
          task_id: trabajo.task_id,
          run_id: trabajo.run_id,
          agent_id: agent.id,
          payload: { status: 'failed', error: e instanceof Error ? e.message : String(e) },
        });
      })
      .finally(() => {
        this.activos.delete(workerId);
        if (!this.parando) void this.tick();
      });
  }

  /**
   * Ejecuta un turno del orquestador: le entrega el estado del proyecto y el último
   * mensaje del creador, y aplica el plan que devuelve.
   */
  private async runOrchestratorTurn(): Promise<void> {
    // Se fija el proyecto al empezar el turno. Si el creador abre otra carpeta mientras el
    // orquestador piensa, su plan se aplica al proyecto que lo pidió y no al nuevo.
    const projectId = this.projectId;

    const agent = listAgents(this.db, projectId).find((a) => a.role === 'orchestrator' && a.enabled);
    if (!agent) return;

    try {
      const snapshot = projectSnapshot(this.db, projectId);
      const ultimo = [...snapshot.chat].reverse().find((m) => m.author === 'creator');
      const prompt = renderOrchestratorPrompt(snapshot, ultimo?.body ?? 'Revisa el estado y decide qué hace falta.');

      appendEvent(this.db, this.bus, {
        project_id: projectId,
        type: 'run.started',
        agent_id: agent.id,
        payload: { role: 'orchestrator', engine: this.motorDe(agent).name },
      });

      const handle = this.motorDe(agent).start({
        prompt,
        cwd: requireProject(this.db, projectId).repo_path,
        // El orquestador no escribe código. Solo puede mirar para entender el proyecto.
        allowedTools: agentTools(agent),
        timeoutMs: requireProject(this.db, projectId).run_timeout_ms,
        model: agent.model,
        resultSchema: ORCHESTRATOR_PLAN_JSON_SCHEMA,
        systemPromptAppend: instructionsFor(agent.role),
        permissionMode: 'manual',
        usePersonalConfig: requireProject(this.db, projectId).use_personal_config === 1,
      },
      // El orquestador publica lo que va haciendo, igual que los demás agentes. Sin esto,
      // el creador solo ve un mensaje fijo mientras espera.
      (progreso) => {
        appendEvent(this.db, this.bus, {
          project_id: projectId,
          type: 'run.progress',
          agent_id: agent.id,
          payload: {
            kind: progreso.kind,
            tool: progreso.tool ?? null,
            text: progreso.text,
            is_error: progreso.isError ?? false,
          },
        });
      });

      this.handleOrquestador = handle;
      const outcome = await handle.wait();
      this.handleOrquestador = null;

      // El turno del orquestador también consume cuota, y el motor la informa igual que en
      // cualquier otra ejecución. Es lo que mantiene la cifra al día: se habla con el
      // orquestador mucho más a menudo de lo que terminan las tareas.
      saveUsage(this.db, this.bus, this.motorDe(agent).name, outcome);

      if (outcome.status === 'cancelled') {
        postChatMessage(
          this.db,
          this.bus,
          projectId,
          'orchestrator',
          'He parado a mitad, así que no he creado ninguna tarea. Dime qué quieres cambiar.',
        );
        return;
      }

      if (outcome.status !== 'succeeded' || !outcome.resultText) {
        postChatMessage(
          this.db,
          this.bus,
          projectId,
          'orchestrator',
          `No he podido preparar el plan: ${outcome.error ?? 'el motor no devolvió nada'}.`,
        );
        return;
      }

      const validado = orchestratorPlanSchema.safeParse(JSON.parse(outcome.resultText));
      if (!validado.success) {
        postChatMessage(
          this.db,
          this.bus,
          projectId,
          'orchestrator',
          'He preparado un plan que no cumple el formato acordado. Vuelve a pedírmelo, por favor.',
        );
        return;
      }

      const resultado = applyPlan(this.db, this.bus, projectId, validado.data);

      appendEvent(this.db, this.bus, {
        project_id: projectId,
        type: 'run.finished',
        agent_id: agent.id,
        payload: {
          status: 'succeeded',
          summary: resultado.created_tasks.length > 0
            ? `Ha repartido ${resultado.created_tasks.length} tareas.`
            : 'Ha respondido sin crear tareas.',
        },
      });

      if (resultado.errors.length > 0) {
        postChatMessage(
          this.db,
          this.bus,
          projectId,
          'orchestrator',
          `Parte del plan no se pudo aplicar:\n${resultado.errors.map((e) => `- ${e}`).join('\n')}`,
        );
      }
    } catch (e) {
      postChatMessage(
        this.db,
        this.bus,
        projectId,
        'orchestrator',
        `Ha fallado mi turno: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/**
 * Devuelve a la cola las tareas cuyas ejecuciones figuraban activas.
 *
 * Al arrancar no puede haber ninguna ejecución en marcha, porque sus procesos ya no
 * existen. Se marcan como interrumpidas con su motivo y sus tareas vuelven a estar listas
 * (documento 07, apartado 7.11).
 */
export function recoverInterruptedRuns(
  db: Db,
  bus: EventBus,
  projectId: string,
  /**
   * Ejecuciones que siguen vivas en este proceso. Al abrir de nuevo una carpeta que se
   * dejó a medias, sus workers pueden seguir trabajando, y darlos por interrumpidos
   * tiraría el trabajo de alguien que está vivo.
   */
  enMarcha: ReadonlySet<string> = new Set(),
): number {
  const colgadas = (db
    .prepare(
      `SELECT r.id, r.task_id FROM runs r
       JOIN tasks t ON t.id = r.task_id
       WHERE t.project_id = ? AND r.status = 'running'`,
    )
    .all(projectId) as Array<{ id: string; task_id: string }>)
    .filter((run) => !enMarcha.has(run.id));

  for (const run of colgadas) {
    db.prepare(
      "UPDATE runs SET status = 'interrupted', error = ?, ended_at = datetime('now') WHERE id = ?",
    ).run('El sistema se reinició mientras la ejecución estaba en marcha.', run.id);

    db.prepare(
      `UPDATE tasks SET status = 'ready', active_run_id = NULL, updated_at = datetime('now')
       WHERE id = ? AND status = 'in_progress'`,
    ).run(run.task_id);

    appendEvent(db, bus, {
      project_id: projectId,
      type: 'run.finished',
      task_id: run.task_id,
      run_id: run.id,
      payload: { status: 'interrupted', reason: 'el sistema se reinició' },
    });

    // El worktree se conserva a propósito: el siguiente intento lo reutiliza y no pierde
    // lo que el intento anterior dejó escrito.
    requireTask(db, run.task_id);
  }

  return colgadas.length;
}

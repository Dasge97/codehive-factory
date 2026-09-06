import type { Db } from '../core/db.js';
import { EventBus, appendEvent } from '../core/events.js';
import { agentTools, listAgents, requireProject } from '../core/projects.js';
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
import { runTask } from './runner.js';

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
  private renovacion: NodeJS.Timeout | null = null;
  private parando = false;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly projectId: string,
    private readonly engine: Engine,
    private readonly options: SupervisorOptions = {},
  ) {}

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

    const project = requireProject(this.db, this.projectId);
    if (project.status !== 'active') return;

    if (this.sinCuota()) return;

    // Antes de repartir trabajo nuevo se recupera el de los workers que se perdieron.
    reclaimExpiredLeases(this.db, this.bus, this.projectId);

    if (this.turnoOrquestadorPendiente && !this.turnoOrquestador) {
      this.turnoOrquestadorPendiente = false;
      this.turnoOrquestador = this.runOrchestratorTurn().finally(() => {
        this.turnoOrquestador = null;
        if (!this.parando) void this.tick();
      });
    }

    if (this.activos.size >= project.max_concurrent_runs) return;

    for (const agent of listAgents(this.db, this.projectId)) {
      if (agent.role === 'orchestrator' || !agent.enabled) continue;
      if (this.activos.size >= project.max_concurrent_runs) break;
      if (this.ocupadosDe(agent.id) >= agent.max_workers) continue;
      if (queueForRole(this.db, this.projectId, agent.role).length === 0) continue;

      this.arrancarWorker(agent);
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
  private sinCuota(): boolean {
    const uso = this.db
      .prepare('SELECT status FROM engine_usage WHERE engine = ?')
      .get(this.engine.name) as { status: string } | undefined;
    return uso?.status === 'exhausted' || uso?.status === 'rejected';
  }

  private arrancarWorker(agent: Agent): void {
    const workerId = newId('worker');
    const claim = claimNext(this.db, this.bus, this.projectId, agent.role, {
      agent_id: agent.id,
      worker_id: workerId,
      engine: this.engine.name,
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
      engine: this.engine,
    })
      .then(() => undefined)
      .catch((e) => {
        appendEvent(this.db, this.bus, {
          project_id: this.projectId,
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
    const agent = listAgents(this.db, this.projectId).find((a) => a.role === 'orchestrator' && a.enabled);
    if (!agent) return;

    try {
      const snapshot = projectSnapshot(this.db, this.projectId);
      const ultimo = [...snapshot.chat].reverse().find((m) => m.author === 'creator');
      const prompt = renderOrchestratorPrompt(snapshot, ultimo?.body ?? 'Revisa el estado y decide qué hace falta.');

      const handle = this.engine.start({
        prompt,
        cwd: requireProject(this.db, this.projectId).repo_path,
        // El orquestador no escribe código. Solo puede mirar para entender el proyecto.
        allowedTools: agentTools(agent),
        timeoutMs: requireProject(this.db, this.projectId).run_timeout_ms,
        model: agent.model,
        resultSchema: ORCHESTRATOR_PLAN_JSON_SCHEMA,
        systemPromptAppend: agent.instructions,
        permissionMode: 'manual',
      });

      const outcome = await handle.wait();

      if (outcome.status !== 'succeeded' || !outcome.resultText) {
        postChatMessage(
          this.db,
          this.bus,
          this.projectId,
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
          this.projectId,
          'orchestrator',
          'He preparado un plan que no cumple el formato acordado. Vuelve a pedírmelo, por favor.',
        );
        return;
      }

      const resultado = applyPlan(this.db, this.bus, this.projectId, validado.data);

      if (resultado.errors.length > 0) {
        postChatMessage(
          this.db,
          this.bus,
          this.projectId,
          'orchestrator',
          `Parte del plan no se pudo aplicar:\n${resultado.errors.map((e) => `- ${e}`).join('\n')}`,
        );
      }
    } catch (e) {
      postChatMessage(
        this.db,
        this.bus,
        this.projectId,
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
export function recoverInterruptedRuns(db: Db, bus: EventBus, projectId: string): number {
  const colgadas = db
    .prepare(
      `SELECT r.id, r.task_id FROM runs r
       JOIN tasks t ON t.id = r.task_id
       WHERE t.project_id = ? AND r.status = 'running'`,
    )
    .all(projectId) as Array<{ id: string; task_id: string }>;

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

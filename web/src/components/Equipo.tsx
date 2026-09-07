import type { AgentView, Task } from '../api';
import { Latido } from './Estado';

const NOMBRE_ROL: Record<AgentView['role'], string> = {
  orchestrator: 'Orquestación',
  builder: 'Construcción',
  reviewer: 'Revisión',
  researcher: 'Investigación',
  refactorer: 'Limpieza',
};

interface Props {
  agentes: AgentView[];
  tareas: Task[];
  seleccionado: string | null;
  alSeleccionar: (agentId: string | null) => void;
}

/**
 * Tarjetas del equipo.
 *
 * Cada tarjeta dice en qué trabaja el agente sin tener que abrir ningún registro, que es
 * el primer criterio de aceptación de la interfaz.
 */
export function Equipo({ agentes, tareas, seleccionado, alSeleccionar }: Props) {
  const porId = new Map(tareas.map((t) => [t.id, t]));

  return (
    <section className="panel">
      <header>
        <h2>Equipo</h2>
        <span className="contador">
          {agentes.filter((a) => a.busy_workers > 0).length} de {agentes.length} trabajando
        </span>
        {seleccionado && (
          <div className="derecha">
            <button className="boton pequeno" onClick={() => alSeleccionar(null)}>
              Quitar el filtro
            </button>
          </div>
        )}
      </header>

      <div className="rejilla-agentes">
        {agentes.map((agente) => {
          const activas = agente.current_tasks.map((id) => porId.get(id)).filter(Boolean) as Task[];
          const trabajando = agente.busy_workers > 0;

          return (
            <button
              key={agente.id}
              className={`agente${seleccionado === agente.id ? ' seleccionado' : ''}`}
              onClick={() => alSeleccionar(seleccionado === agente.id ? null : agente.id)}
              aria-pressed={seleccionado === agente.id}
            >
              <span className="nombre">
                {trabajando && <Latido titulo="Tiene una ejecución en marcha" />}
                {agente.name}
              </span>
              <span className="motor">
                {NOMBRE_ROL[agente.role]} · {agente.engine}
                {agente.model ? ` · ${agente.model}` : ''}
              </span>

              <span className="tarea-actual">
                {activas.length > 0
                  ? activas.map((t) => t.title).join(' · ')
                  : trabajando
                    ? 'Trabajando'
                    : 'Sin tarea activa'}
              </span>

              <span className="pie">
                <span>
                  {agente.busy_workers}/{agente.max_workers} workers
                </span>
                <span>·</span>
                <span>{agente.queue_length} en cola</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export { NOMBRE_ROL };

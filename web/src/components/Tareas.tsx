import type { ReactNode } from 'react';
import type { AgentView, Task, TaskStatus } from '../api';
import { ESTADOS, Estado, Latido } from './Estado';

const TIPO: Record<string, string> = {
  build: 'Construir',
  review: 'Revisar',
  fix: 'Corregir',
  research: 'Investigar',
  integrate: 'Integrar',
};

interface TarjetaProps {
  tarea: Task;
  atenuada?: boolean;
  alAbrir: (taskId: string) => void;
}

/**
 * Tarjeta de una tarea.
 *
 * Muestra el motivo cuando algo la detiene: qué falta y quién puede resolverlo. Una tarea
 * bloqueada sin explicación no sirve de nada al creador.
 */
export function TarjetaTarea({ tarea, atenuada, alAbrir }: TarjetaProps) {
  const nota =
    tarea.blocked_reason ??
    tarea.waiting_for ??
    (tarea.needs_reeval ? 'Un cambio de requisito la afecta: hay que reevaluarla.' : null);

  return (
    <button
      className={`tarea${atenuada ? ' atenuada' : ''}`}
      data-estado={tarea.status}
      onClick={() => alAbrir(tarea.id)}
    >
      <span className="titulo">{tarea.title}</span>

      <span className="meta">
        <Estado estado={tarea.status} />
        {tarea.status === 'in_progress' && <Latido titulo="Ejecución en marcha" />}
        <span>{TIPO[tarea.kind] ?? tarea.kind}</span>
        <span>·</span>
        <span>prioridad {tarea.priority}</span>
        {(tarea.findings_open ?? 0) > 0 && (
          <>
            <span>·</span>
            <span>{tarea.findings_open} hallazgos abiertos</span>
          </>
        )}
        {tarea.attempts > 1 && (
          <>
            <span>·</span>
            <span>{tarea.attempts} intentos</span>
          </>
        )}
      </span>

      {nota && <span className="nota">{nota}</span>}
    </button>
  );
}

interface ListaProps {
  tareas: Task[];
  agentes: AgentView[];
  agenteSeleccionado: string | null;
  alAbrir: (taskId: string) => void;
  /** Paso del recorrido por el que se está filtrando, si hay alguno. */
  filtro?: { paso: string; alQuitar: () => void } | null;
  accionExtra?: ReactNode;
}

/** Nombre en palabras de cada paso del recorrido, para explicar el filtro activo. */
const NOMBRE_PASO: Record<string, string> = {
  reparte: 'que el orquestador está repartiendo',
  construye: 'que se están construyendo',
  revisa: 'que se están revisando',
  integras: 'que esperan a que las integres',
  atascado: 'que están atascadas',
};

/** Trabajo del proyecto, ordenado por lo que más atención necesita. */
export function TrabajoDelProyecto({
  tareas,
  agentes,
  agenteSeleccionado,
  alAbrir,
  filtro,
  accionExtra,
}: ListaProps) {
  const rolDelAgente = agentes.find((a) => a.id === agenteSeleccionado)?.role;

  const abiertas = tareas.filter((t) => t.status !== 'cancelled');
  const ordenadas = [...abiertas].sort(
    (a, b) => ORDEN_ESTADO[a.status] - ORDEN_ESTADO[b.status] || a.priority - b.priority,
  );

  return (
    <section className="panel">
      <header>
        <h2>Trabajo</h2>
        <span className="contador">
          {filtro ? `${abiertas.length} ${NOMBRE_PASO[filtro.paso] ?? ''}` : `${abiertas.length} tareas abiertas`}
        </span>
        <div className="derecha">
          {filtro && (
            <button className="boton pequeno" onClick={filtro.alQuitar}>
              Ver todas
            </button>
          )}
          {accionExtra}
        </div>
      </header>

      {ordenadas.length === 0 ? (
        <p className="vacio">
          {filtro
            ? 'No hay ninguna tarea en este paso ahora mismo.'
            : 'Todavía no hay ninguna tarea. Pide algo en el chat y el orquestador la creará.'}
        </p>
      ) : (
        <div className="rejilla-tareas">
          {ordenadas.map((tarea) => (
            <TarjetaTarea
              key={tarea.id}
              tarea={tarea}
              atenuada={Boolean(rolDelAgente) && tarea.required_role !== rolDelAgente}
              alAbrir={alAbrir}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Orden en que se muestran los estados: primero lo que necesita atención. */
const ORDEN_ESTADO: Record<TaskStatus, number> = {
  blocked: 0,
  in_progress: 1,
  in_review: 2,
  ready: 3,
  pending: 4,
  done: 5,
  cancelled: 6,
};

const COLUMNAS: TaskStatus[] = ['pending', 'ready', 'in_progress', 'in_review', 'blocked', 'done'];

/** Vista de tablero: las mismas tareas agrupadas por estado. */
export function Tablero({ tareas, alAbrir }: { tareas: Task[]; alAbrir: (id: string) => void }) {
  return (
    <section className="panel">
      <header>
        <h2>Tablero por estados</h2>
        <span className="contador">{tareas.filter((t) => t.status !== 'cancelled').length} tareas</span>
      </header>

      <div className="tablero">
        {COLUMNAS.map((estado) => {
          const suyas = tareas.filter((t) => t.status === estado);
          return (
            <div className="columna" key={estado}>
              <h3>
                <span aria-hidden="true">{ESTADOS[estado].icono}</span>
                {ESTADOS[estado].texto}
                <span className="contador">{suyas.length}</span>
              </h3>
              {suyas.map((tarea) => (
                <TarjetaTarea key={tarea.id} tarea={tarea} alAbrir={alAbrir} />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

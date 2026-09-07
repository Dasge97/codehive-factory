import { useEffect, useRef } from 'react';
import type { AgentView, SystemEvent, Task } from '../api';
import { hora } from './Estado';

/**
 * Recorta un texto a lo que cabe en el panel, sin cortar a mitad de palabra si se puede.
 *
 * Los agentes escriben resúmenes largos y el panel es estrecho. El texto entero está en
 * la tarea; aquí basta con saber qué hizo.
 */
function recortar(texto: string, maximo: number): string {
  const limpio = texto.replace(/\s+/g, ' ').trim();
  if (limpio.length <= maximo) return limpio;

  const corte = limpio.lastIndexOf(' ', maximo);
  return `${limpio.slice(0, corte > maximo * 0.6 ? corte : maximo)}…`;
}

/**
 * Color de cada rol.
 *
 * Cada agente tiene el suyo para poder distinguirlos de un vistazo cuando hay varios
 * paneles a la vez. Se aplica al borde y al indicador, no al fondo, para no pelearse con
 * los colores de estado de las tareas.
 */
export const COLOR_ROL: Record<AgentView['role'], string> = {
  orchestrator: 'orquestador',
  builder: 'builder',
  reviewer: 'reviewer',
  researcher: 'investigador',
  refactorer: 'refactorer',
};

const NOMBRE_ROL: Record<AgentView['role'], string> = {
  orchestrator: 'Orquestación',
  builder: 'Construcción',
  reviewer: 'Revisión',
  researcher: 'Investigación',
  refactorer: 'Limpieza',
};

/** Un paso del trabajo de un agente, sacado de los eventos que publica el motor. */
export interface PasoDeAgente {
  id: number;
  hora: string;
  texto: string;
  herramienta: string | null;
  esError: boolean;
}

/**
 * Saca de los eventos lo que ha ido haciendo cada agente.
 *
 * Es lo que hace que el panel de un agente se parezca a mirar su terminal: cada paso que
 * el motor publica aparece ahí, con la herramienta que usó.
 */
export function pasosPorAgente(eventos: SystemEvent[], limite = 40): Map<string, PasoDeAgente[]> {
  const porAgente = new Map<string, PasoDeAgente[]>();

  // Los eventos llegan del más reciente al más antiguo; el panel se lee al revés.
  for (const evento of [...eventos].reverse()) {
    if (!evento.agent_id) continue;

    let datos: Record<string, unknown> = {};
    try {
      datos = JSON.parse(evento.payload) as Record<string, unknown>;
    } catch {
      continue;
    }

    const paso = pasoDelEvento(evento, datos);
    if (!paso) continue;

    const lista = porAgente.get(evento.agent_id) ?? [];
    lista.push(paso);
    porAgente.set(evento.agent_id, lista.slice(-limite));
  }

  return porAgente;
}

function pasoDelEvento(evento: SystemEvent, datos: Record<string, unknown>): PasoDeAgente | null {
  const base = { id: evento.id, hora: hora(evento.created_at) };

  if (evento.type === 'run.started') {
    return { ...base, texto: 'Empieza a trabajar', herramienta: null, esError: false };
  }

  if (evento.type === 'run.finished') {
    const estado = String(datos['status'] ?? '');
    // El resumen entero se lee en la tarea; aquí solo cabe su primera frase.
    const resumen = recortar(String(datos['summary'] ?? datos['error'] ?? ''), 160);
    return {
      ...base,
      texto: estado === 'succeeded' ? `Termina: ${resumen}` : `Termina con ${estado}: ${resumen}`,
      herramienta: null,
      esError: estado !== 'succeeded',
    };
  }

  if (evento.type === 'run.progress') {
    const texto = recortar(String(datos['text'] ?? ''), 220);
    if (!texto) return null;
    return {
      ...base,
      texto,
      herramienta: datos['tool'] ? String(datos['tool']) : null,
      esError: datos['is_error'] === true,
    };
  }

  return null;
}

interface Props {
  agente: AgentView;
  tareas: Task[];
  pasos: PasoDeAgente[];
  alAbrirTarea: (taskId: string) => void;
  /** El panel del orquestador es más ancho y lleva el chat, así que se pinta aparte. */
  compacto?: boolean;
  /** Este panel es el que estás mirando: se ve entero y por delante de los demás. */
  enfocado?: boolean;
  /** Pulsar en cualquier sitio del panel lo pone en primer plano. */
  alEnfocar?: () => void;
}

/**
 * Panel de un agente.
 *
 * Muestra en qué trabaja y lo que va haciendo, paso a paso. La idea es la misma que tener
 * su terminal abierta al lado, pero con lo que hace explicado en lugar de en bruto.
 */
export function PanelAgente({
  agente,
  tareas,
  pasos,
  alAbrirTarea,
  compacto = false,
  enfocado = false,
  alEnfocar,
}: Props) {
  const registro = useRef<HTMLDivElement>(null);
  const trabajando = agente.busy_workers > 0;
  const actuales = agente.current_tasks
    .map((id) => tareas.find((t) => t.id === id))
    .filter(Boolean) as Task[];

  // El panel se mantiene mirando el último paso, como una terminal.
  useEffect(() => {
    const nodo = registro.current;
    if (!nodo) return;
    try {
      nodo.scrollTop = nodo.scrollHeight;
    } catch {
      // Sin desplazamiento automático.
    }
  }, [pasos.length]);

  return (
    <section
      className={`agente-panel${trabajando ? ' activo' : ''}${compacto ? ' compacto' : ''}${
        enfocado ? ' enfocado' : ''
      }`}
      data-rol={COLOR_ROL[agente.role]}
      // Con el ratón basta con pulsar; con el teclado, llegar al panel ya lo enfoca.
      onMouseDown={alEnfocar}
      onFocusCapture={alEnfocar}
    >
      <header>
        <span className={`indicador${trabajando ? ' latiendo' : ''}`} aria-hidden="true" />
        <div className="quien">
          <strong>{agente.name}</strong>
          <span className="rol">
            {NOMBRE_ROL[agente.role]} · {agente.engine}
          </span>
        </div>
        <span className={`situacion${trabajando ? ' trabajando' : ''}`}>
          {trabajando ? 'trabajando' : agente.queue_length > 0 ? `${agente.queue_length} en cola` : 'libre'}
        </span>
      </header>

      {actuales.length > 0 ? (
        <button className="tarea-actual" onClick={() => alAbrirTarea(actuales[0]!.id)}>
          {actuales.map((t) => t.title).join(' · ')}
        </button>
      ) : (
        <p className="tarea-actual vacia">
          {agente.queue_length > 0 ? 'Esperando un hueco para empezar' : 'Sin tarea asignada'}
        </p>
      )}

      <div className="registro-agente" ref={registro}>
        {pasos.length === 0 ? (
          <p className="sin-pasos">Todavía no ha hecho nada.</p>
        ) : (
          pasos.map((paso) => (
            <div key={paso.id} className={`paso-agente${paso.esError ? ' con-error' : ''}`}>
              <span className="hora">{paso.hora}</span>
              {paso.herramienta && <span className="herramienta">{paso.herramienta}</span>}
              <span className="texto">{paso.texto}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export { NOMBRE_ROL };

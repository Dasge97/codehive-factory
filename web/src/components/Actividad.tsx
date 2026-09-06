import type { SystemEvent } from '../api';
import { hora } from './Estado';

/**
 * Traduce un evento a una frase que se entiende sin saber cómo funciona el sistema.
 *
 * Los eventos que no aportan nada al creador se dejan fuera de la lista: el registro
 * detallado de cada paso vive dentro de la tarea, no en la pantalla principal.
 */
export function describir(evento: SystemEvent): string | null {
  let datos: Record<string, unknown> = {};
  try {
    datos = JSON.parse(evento.payload) as Record<string, unknown>;
  } catch {
    datos = {};
  }

  const texto = (clave: string): string => String(datos[clave] ?? '');

  switch (evento.type) {
    case 'task.created':
      return `Tarea creada: ${((datos['task'] as { title?: string })?.title) ?? 'sin título'}`;

    case 'task.status_changed':
      return null; // Cada cambio de estado ya se ve en la tarjeta de la tarea.

    case 'task.blocked':
      return `Tarea bloqueada: ${texto('reason')}`;

    case 'run.started':
      return 'Un agente ha empezado a trabajar en una tarea';

    case 'run.finished': {
      const estado = texto('status');
      if (estado === 'succeeded') return `Ejecución terminada: ${texto('summary') || 'sin resumen'}`;
      if (estado === 'interrupted') return 'Una ejecución quedó interrumpida y su tarea vuelve a la cola';
      if (estado === 'timed_out') return 'Una ejecución superó su tiempo máximo';
      return `Una ejecución falló: ${texto('error')}`;
    }

    case 'increment.published':
      return `Incremento publicado: ${texto('message')}`;

    case 'finding.opened':
      return `Hallazgo ${texto('severity')}: ${texto('title')}`;

    case 'finding.resolved':
      return 'Un hallazgo se ha dado por resuelto';

    case 'approval.requested':
      return `El agente pidió permiso para usar ${texto('tool_name')}`;

    case 'approval.resolved':
      return datos['granted'] ? 'Autorización concedida' : 'Autorización denegada';

    case 'decision.recorded':
      return `Decisión registrada: ${texto('title')}`;

    case 'chat.message':
      return null; // La conversación tiene su propio panel.

    case 'integration.completed':
      return datos['integrated']
        ? `Rama integrada en la principal: ${texto('branch')}`
        : `No se pudo integrar: ${texto('reason')}`;

    case 'quota.exhausted':
      return 'El motor se ha quedado sin cuota';

    case 'run.progress':
      return null; // El detalle paso a paso vive dentro de la tarea.

    default:
      return null;
  }
}

interface Props {
  eventos: SystemEvent[];
  alAbrirTarea: (taskId: string) => void;
}

export function Actividad({ eventos, alAbrirTarea }: Props) {
  const visibles = eventos
    .map((evento) => ({ evento, texto: describir(evento) }))
    .filter((e): e is { evento: SystemEvent; texto: string } => e.texto !== null)
    .slice(0, 40);

  return (
    <section className="panel">
      <header>
        <h2>Actividad</h2>
        <span className="contador">{visibles.length}</span>
      </header>

      {visibles.length === 0 ? (
        <p className="vacio">Todavía no ha pasado nada.</p>
      ) : (
        <div className="actividad">
          {visibles.map(({ evento, texto }) => (
            <button
              key={evento.id}
              onClick={() => evento.task_id && alAbrirTarea(evento.task_id)}
              disabled={!evento.task_id}
            >
              <span className="hora">{hora(evento.created_at)}</span>
              <span>{texto}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

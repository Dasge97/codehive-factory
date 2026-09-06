import type { Task } from '../api';

/**
 * Los pasos por los que pasa todo lo que pides.
 *
 * Existe porque el recorrido no se deduce mirando una lista de tareas con estados
 * sueltos: hace falta ver el camino entero y en qué punto está cada cosa.
 */
export const PASOS = [
  {
    id: 'reparte',
    titulo: 'Se reparte',
    explicacion: 'El orquestador convierte lo que has pedido en tareas concretas.',
  },
  {
    id: 'construye',
    titulo: 'Se construye',
    explicacion: 'Un agente escribe el código en una rama aparte y publica un commit.',
  },
  {
    id: 'revisa',
    titulo: 'Se revisa',
    explicacion: 'Otro agente revisa ese commit. Si encuentra un fallo, abre una corrección.',
  },
  {
    id: 'integras',
    titulo: 'Tú integras',
    explicacion: 'Nada llega a la rama principal sin que tú lo confirmes.',
  },
] as const;

export type PasoId = (typeof PASOS)[number]['id'];

/**
 * En qué paso del recorrido está una tarea.
 *
 * Devuelve null para lo que ya no está en marcha: terminado sin código que integrar, o
 * cancelado.
 */
export function pasoDeLaTarea(tarea: Task, integrables: Set<string>): PasoId | 'atascado' | null {
  if (tarea.status === 'cancelled') return null;
  if (tarea.status === 'blocked') return 'atascado';
  if (integrables.has(tarea.id)) return 'integras';
  if (tarea.status === 'done') return null;
  if (tarea.status === 'pending') return 'reparte';
  if (tarea.status === 'in_review') return 'revisa';
  if (tarea.kind === 'review') return 'revisa';
  return 'construye';
}

interface Props {
  tareas: Task[];
  integrables: string[];
  pasoSeleccionado: PasoId | 'atascado' | null;
  alSeleccionar: (paso: PasoId | 'atascado' | null) => void;
}

/** Fila con el recorrido y cuántas tareas hay en cada paso. */
export function Recorrido({ tareas, integrables, pasoSeleccionado, alSeleccionar }: Props) {
  const integrablesSet = new Set(integrables);

  const cuenta = (paso: PasoId | 'atascado') =>
    tareas.filter((t) => pasoDeLaTarea(t, integrablesSet) === paso).length;

  const atascadas = cuenta('atascado');

  return (
    <section className="recorrido" aria-label="Recorrido del trabajo">
      <span className="origen">Tú pides</span>

      {PASOS.map((paso) => {
        const total = cuenta(paso.id);
        const activo = pasoSeleccionado === paso.id;

        return (
          <button
            key={paso.id}
            className={`paso${total > 0 ? ' con-trabajo' : ''}${activo ? ' seleccionado' : ''}`}
            title={paso.explicacion}
            aria-pressed={activo}
            onClick={() => alSeleccionar(activo ? null : paso.id)}
          >
            <span className="nombre">{paso.titulo}</span>
            <span className="cuenta">{total}</span>
          </button>
        );
      })}

      {atascadas > 0 && (
        <button
          className={`paso atascado${pasoSeleccionado === 'atascado' ? ' seleccionado' : ''}`}
          title="Estas tareas necesitan algo que no tienen. Ábrelas para ver qué les falta."
          aria-pressed={pasoSeleccionado === 'atascado'}
          onClick={() => alSeleccionar(pasoSeleccionado === 'atascado' ? null : 'atascado')}
        >
          <span className="nombre">Atascado</span>
          <span className="cuenta">{atascadas}</span>
        </button>
      )}
    </section>
  );
}

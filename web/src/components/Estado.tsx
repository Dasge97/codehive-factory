import type { TaskStatus } from '../api';

/**
 * Cada estado tiene icono y texto además de color.
 *
 * Es lo que permite distinguirlos sin depender de la vista del color, y también lo que
 * hace legible una captura en blanco y negro.
 */
export const ESTADOS: Record<TaskStatus, { texto: string; icono: string; explicacion: string }> = {
  pending: { texto: 'Pendiente', icono: '○', explicacion: 'Le falta una dependencia o una respuesta.' },
  ready: { texto: 'Lista', icono: '◔', explicacion: 'Puede empezar en cuanto haya un worker libre.' },
  in_progress: { texto: 'En curso', icono: '◑', explicacion: 'Hay una ejecución en marcha ahora mismo.' },
  in_review: { texto: 'En revisión', icono: '◕', explicacion: 'Ha publicado un commit y espera al reviewer.' },
  blocked: { texto: 'Bloqueada', icono: '⊘', explicacion: 'Necesita una decisión o un recurso.' },
  done: { texto: 'Hecha', icono: '●', explicacion: 'Cumple sus criterios y no arrastra hallazgos bloqueantes.' },
  cancelled: { texto: 'Cancelada', icono: '×', explicacion: 'Ya no forma parte del trabajo pedido.' },
};

export function Estado({ estado, titulo }: { estado: TaskStatus; titulo?: string }) {
  const info = ESTADOS[estado];
  return (
    <span className="estado" data-estado={estado} title={titulo ?? info.explicacion}>
      <span className="icono" aria-hidden="true">{info.icono}</span>
      {info.texto}
    </span>
  );
}

/** Punto que late mientras hay una ejecución realmente en marcha. */
export function Latido({ titulo }: { titulo: string }) {
  return <span className="latido" role="img" aria-label={titulo} title={titulo} />;
}

/** Hora corta, para las listas de actividad. */
export function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

/** Cuánto hace que pasó algo, en palabras. */
export function haceCuanto(iso: string): string {
  const segundos = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (segundos < 60) return 'hace un momento';
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `hace ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;
  return `hace ${Math.floor(horas / 24)} días`;
}

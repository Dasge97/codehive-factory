import type { AgentView, EngineUsage, ProjectMode, ProjectOverview } from '../api';
import { COLOR_ROL } from './PanelAgente';

interface Props {
  resumen: ProjectOverview;
  agentes: AgentView[];
  tema: 'sistema' | 'claro' | 'oscuro';
  alCambiarTema: () => void;
  alAbrirAjustes: () => void;
  /** El cajón del trabajo está abierto. */
  trabajoAbierto: boolean;
  alAlternarTrabajo: () => void;
  tareasAbiertas: number;
  tareasAtascadas: number;
  listasParaIntegrar: number;
  alCambiarModo: (modo: ProjectMode) => void;
  /** Abre el selector de carpeta. La ruta de la cabecera es lo que se pulsa. */
  alAbrirCarpeta: () => void;
  /** Pulsar en la cabecera quita el foco del agente que lo tuviera. */
  alQuitarFoco: () => void;
}

/**
 * Cabecera del proyecto, en una sola línea.
 *
 * Lleva lo que hay que saber antes de pedir nada: sobre qué carpeta trabaja el equipo, en
 * qué rama, quién está trabajando, en qué modo, y cuánta cuota queda.
 *
 * Va en una línea a propósito. Todo lo que ocupa aquí se lo quita a los paneles de los
 * agentes, que es donde de verdad pasa algo.
 */
export function Cabecera({
  resumen,
  agentes,
  tema,
  alCambiarTema,
  alAbrirAjustes,
  trabajoAbierto,
  alAlternarTrabajo,
  tareasAbiertas,
  tareasAtascadas,
  listasParaIntegrar,
  alCambiarModo,
  alAbrirCarpeta,
  alQuitarFoco,
}: Props) {
  const enPausa = resumen.project.status === 'paused';

  return (
    <header className="cabecera" onMouseDown={alQuitarFoco}>
      <div className="identidad">
        <h1 title={resumen.project.name}>{resumen.project.name}</h1>

        <button
          type="button"
          className="ruta"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={alAbrirCarpeta}
          title={`${resumen.project.repo_path}\nPulsa para trabajar sobre otra carpeta.`}
        >
          {rutaCorta(resumen.project.repo_path)}
        </button>

        <span className="rama" title="Rama en la que se integra el trabajo aprobado">
          {resumen.project.main_branch}
        </span>

        {enPausa && <span className="chip-pausa">en pausa</span>}
      </div>

      <Equipo agentes={agentes} enPausa={enPausa} />

      <div className="cabecera-acciones">
        <Modo modo={resumen.project.mode} alCambiar={alCambiarModo} />

        <Consumo usos={resumen.usage} />

        <button
          className={`boton pequeno boton-trabajo${trabajoAbierto ? ' activo' : ''}`}
          onClick={alAlternarTrabajo}
          aria-pressed={trabajoAbierto}
          aria-label="Ver el trabajo del proyecto"
        >
          Trabajo
          {tareasAbiertas > 0 && <span className="cuenta">{tareasAbiertas}</span>}
          {tareasAtascadas > 0 && <span className="punto atascado" title={`${tareasAtascadas} atascadas`} />}
          {listasParaIntegrar > 0 && (
            <span className="punto listo" title={`${listasParaIntegrar} listas para integrar`} />
          )}
        </button>

        <button className="boton pequeno" onClick={alAbrirAjustes}>
          Ajustes
        </button>

        <button
          className="boton pequeno boton-tema"
          onClick={alCambiarTema}
          title={`${NOMBRE_TEMA[tema]}. Pulsa para cambiar entre claro, oscuro y el del sistema.`}
          aria-label={NOMBRE_TEMA[tema]}
        >
          {ICONO_TEMA[tema]}
        </button>
      </div>
    </header>
  );
}

const NOMBRE_TEMA = {
  sistema: 'Tema del sistema',
  claro: 'Tema claro',
  oscuro: 'Tema oscuro',
} as const;

const ICONO_TEMA = { sistema: '◐', claro: '☀', oscuro: '☾' } as const;

/**
 * Deja de una ruta la carpeta y la de encima.
 *
 * El principio de una ruta larga no identifica nada y se come el ancho de la cabecera. El
 * final sí dice de qué carpeta se trata. La ruta entera sigue estando al pasar el ratón.
 */
export function rutaCorta(ruta: string): string {
  const partes = ruta.replace(/\\/g, '/').split('/').filter(Boolean);
  return partes.slice(-2).join('/') || ruta;
}

/** Cómo se llama cada estado de un agente, para poder decirlo con palabras. */
const ESTADO_EN_PALABRAS = {
  trabajando: 'trabajando',
  libre: 'libre',
  apagado: 'desactivado',
  pausa: 'parado, el proyecto está en pausa',
} as const;

type EstadoDeAgente = keyof typeof ESTADO_EN_PALABRAS;

export function estadoDeAgente(agente: AgentView, enPausa: boolean): EstadoDeAgente {
  if (!agente.enabled) return 'apagado';
  if (agente.busy_workers > 0) return 'trabajando';
  if (enPausa) return 'pausa';
  return 'libre';
}

/**
 * El equipo, como un punto por agente.
 *
 * Cada punto lleva el color de su rol y dice en qué está: relleno y latiendo si trabaja,
 * hueco si está libre, apagado si el agente está desactivado o el proyecto en pausa.
 *
 * Ocupa una quinta parte de lo que ocupaba la frase que había antes, y dice más: se ve
 * quién trabaja, no solo cuántos.
 */
function Equipo({ agentes, enPausa }: { agentes: AgentView[]; enPausa: boolean }) {
  if (agentes.length === 0) return null;

  const resumen = agentes
    .map((a) => `${a.name}: ${ESTADO_EN_PALABRAS[estadoDeAgente(a, enPausa)]}`)
    .join('. ');

  return (
    <div className="equipo-puntos" role="group" aria-label={`Estado del equipo. ${resumen}`}>
      {agentes.map((agente) => {
        const estado = estadoDeAgente(agente, enPausa);
        const cola = agente.queue_length > 0 ? `, ${agente.queue_length} en cola` : '';
        return (
          <span
            key={agente.id}
            className="punto-agente"
            data-rol={COLOR_ROL[agente.role]}
            data-estado={estado}
            title={`${agente.name}: ${ESTADO_EN_PALABRAS[estado]}${cola}`}
          />
        );
      })}
    </div>
  );
}

/**
 * Interruptor entre los dos modos de trabajo.
 *
 * En modo normal el orquestador decide qué necesita revisión, y solo trabaja quien haga
 * falta. En modo estricto todo lo que deja un commit se revisa y después pasa por el
 * refactorer.
 *
 * El modo se graba en cada tarea al crearla, así que cambiarlo no altera el trabajo que
 * ya está en marcha.
 */
function Modo({ modo, alCambiar }: { modo: ProjectMode; alCambiar: (modo: ProjectMode) => void }) {
  return (
    <div className="modo" role="group" aria-label="Modo de trabajo">
      <button
        className={`boton pequeno${modo === 'normal' ? ' activo' : ''}`}
        aria-pressed={modo === 'normal'}
        onClick={() => alCambiar('normal')}
        title="Solo trabaja quien haga falta. El orquestador decide qué se revisa."
      >
        Normal
      </button>
      <button
        className={`boton pequeno${modo === 'strict' ? ' activo' : ''}`}
        aria-pressed={modo === 'strict'}
        onClick={() => alCambiar('strict')}
        title="Se revisa todo y el trabajo aprobado pasa además por el refactorer."
      >
        Estricto
      </button>
    </div>
  );
}

/** Nombre corto de cada motor, para que se vea de quién es la cuota. */
const NOMBRE_MOTOR: Record<string, string> = { claude_code: 'Claude', codex: 'Codex' };

/** A partir de aquí, una medida es vieja y conviene decirlo. */
const MEDIDA_VIEJA_MS = 2 * 60 * 60 * 1000;

/**
 * Consumo de cada suscripción que informa de él.
 *
 * Se enseña una pastilla por motor, con su nombre. Un motor que no informa no aparece, en
 * lugar de dejar creer que la cifra de otro es la de todo el sistema.
 *
 * La cifra la publica el motor dentro de una ejecución, y no hay forma de preguntarla
 * aparte. Cuando la medida es de hace rato, se dice de cuándo es en vez de enseñarla como
 * si fuera de ahora mismo.
 */
function Consumo({ usos }: { usos: EngineUsage[] }) {
  const conDato = usos.filter((u) => u.five_hour_util !== null);
  if (conDato.length === 0) return null;

  return (
    <>
      {conDato.map((uso) => {
        const porcentaje = Math.round((uso.five_hour_util ?? 0) * 100);
        const medida = new Date(uso.updated_at);
        const vieja = Date.now() - medida.getTime() > MEDIDA_VIEJA_MS;

        const reinicio = uso.five_hour_resets
          ? new Date(uso.five_hour_resets).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
          : null;

        const cuando = medida.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

        return (
          <div
            key={uso.engine}
            className={`consumo${vieja ? ' vieja' : ''}`}
            title={[
              `Consumo de la suscripción de ${NOMBRE_MOTOR[uso.engine] ?? uso.engine}.`,
              `Medido a las ${cuando}, en la última ejecución de ese motor.`,
              reinicio ? `Se reinicia a las ${reinicio}.` : null,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span>
              {NOMBRE_MOTOR[uso.engine] ?? uso.engine} {porcentaje}%
            </span>
            <span className="barra-consumo">
              <span style={{ width: `${Math.min(100, porcentaje)}%` }} />
            </span>
          </div>
        );
      })}
    </>
  );
}

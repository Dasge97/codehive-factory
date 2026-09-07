import type { AgentView, EngineUsage, ProjectMode, ProjectOverview } from '../api';

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
  /** Pulsar en la cabecera quita el foco del agente que lo tuviera. */
  alQuitarFoco: () => void;
}

/**
 * Cabecera del proyecto.
 *
 * Lo primero que hay que saber al mirar la pantalla es dónde va a trabajar el equipo, así
 * que la ruta del repositorio y la rama están siempre visibles, no escondidas en un panel
 * de ajustes.
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
  alQuitarFoco,
}: Props) {
  const trabajando = agentes.filter((a) => a.busy_workers > 0).length;
  const uso = resumen.usage.find((u) => u.engine === 'claude_code');

  return (
    <header className="cabecera" onMouseDown={alQuitarFoco}>
      <div className="identidad">
        <h1>{resumen.project.name}</h1>
        <p className="ubicacion">
          <span className="ruta" title="Carpeta del repositorio en la que trabaja el equipo">
            {resumen.project.repo_path}
          </span>
          <span className="separador">·</span>
          <span title="Rama en la que se integra el trabajo aprobado">
            rama {resumen.project.main_branch}
          </span>
          <span className="separador">·</span>
          <span>
            {trabajando > 0
              ? `${trabajando} de ${agentes.length} agentes trabajando`
              : `${agentes.length} agentes en espera`}
          </span>
        </p>
      </div>

      <div className="cabecera-acciones">
        <Modo modo={resumen.project.mode} alCambiar={alCambiarModo} />

        <Consumo uso={uso} />

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

        <button className="boton pequeno" onClick={alAbrirAjustes}>Ajustes</button>
        <button
          className="boton pequeno"
          onClick={alCambiarTema}
          title="Cambiar entre tema claro, oscuro y el del sistema"
        >
          {tema === 'sistema' ? 'Tema del sistema' : tema === 'claro' ? 'Tema claro' : 'Tema oscuro'}
        </button>
      </div>
    </header>
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

/**
 * Consumo de la suscripción.
 *
 * La cifra viene del motor. Si el motor no la ha publicado todavía, no se muestra nada en
 * lugar de inventar un número.
 */
function Consumo({ uso }: { uso: EngineUsage | undefined }) {
  if (!uso || uso.five_hour_util === null) return null;

  const porcentaje = Math.round(uso.five_hour_util * 100);
  const reinicio = uso.five_hour_resets
    ? new Date(uso.five_hour_resets).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div
      className="consumo"
      title={`Consumo de la suscripción de Claude${reinicio ? `. Se reinicia a las ${reinicio}` : ''}`}
    >
      <span>Cuota {porcentaje}%</span>
      <span className="barra-consumo">
        <span style={{ width: `${Math.min(100, porcentaje)}%` }} />
      </span>
    </div>
  );
}

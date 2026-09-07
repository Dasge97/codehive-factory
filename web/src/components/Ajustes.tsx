import { useEffect, useState } from 'react';
import {
  api,
  type AgentView,
  type MotoresDisponibles,
  type ProjectOverview,
  type TurnosDelOrquestador,
} from '../api';
import { NOMBRE_ROL } from './Equipo';

interface Props {
  resumen: ProjectOverview;
  agentes: AgentView[];
  motores: MotoresDisponibles | null;
  alCerrar: () => void;
  alRecargar: () => void;
}

/**
 * Ajustes del proyecto y del equipo.
 *
 * Solo ofrece cambiar lo que el sistema puede aplicar de verdad: el motor de cada agente
 * entre los que están instalados, cuántos workers tiene, si está activo, y los límites del
 * proyecto. Un motor que no esté instalado no aparece como opción.
 */
export function Ajustes({ resumen, agentes, motores, alCerrar, alRecargar }: Props) {
  const [trabajando, setTrabajando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const disponibles = motores?.available.map((m) => m.name) ?? [];
  const enPausa = resumen.project.status === 'paused';
  const aislado = resumen.project.use_personal_config !== 1;

  async function accion(fn: () => Promise<unknown>, exito: string) {
    setTrabajando(true);
    setAviso(null);
    try {
      await fn();
      setAviso(exito);
      alRecargar();
    } catch (e) {
      setAviso(e instanceof Error ? e.message : String(e));
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <div className="detalle-fondo" onClick={alCerrar}>
      <aside className="detalle" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Ajustes">
        <header>
          <h2>Ajustes</h2>
          <button className="boton pequeno" onClick={alCerrar}>Cerrar</button>
        </header>

        <div className="contenido">
          <div className="bloque">
            <h3>Proyecto</h3>
            <dl className="lista-datos">
              <dt>Repositorio</dt>
              <dd className="commit">{resumen.project.repo_path}</dd>
              <dt>Rama principal</dt>
              <dd className="commit">{resumen.project.main_branch}</dd>
              <dt>Verificación</dt>
              <dd className="commit">{resumen.project.verify_command ?? 'ninguna'}</dd>
              <dt>Estado</dt>
              <dd>{enPausa ? 'en pausa' : 'activo'}</dd>
            </dl>

            <button
              className="boton"
              style={{ marginTop: 10 }}
              disabled={trabajando}
              onClick={() =>
                void accion(
                  () => api.pausarProyecto(resumen.project.id, !enPausa),
                  enPausa ? 'Proyecto reanudado.' : 'Proyecto en pausa. El trabajo en curso termina y no se arranca nada nuevo.',
                )
              }
            >
              {enPausa ? 'Reanudar el proyecto' : 'Pausar el proyecto'}
            </button>
          </div>

          <CosteDelOrquestador projectId={resumen.project.id} />

          <div className="bloque">
            <h3>Configuración de los motores</h3>
            <p style={{ fontSize: 12.5, color: 'var(--texto-suave)' }}>
              Los motores se pueden lanzar aislados o con la configuración personal de quien
              arranca el sistema: su CLAUDE.md, sus hooks, sus ficheros de ajustes y sus
              servidores MCP. Aislados, el proyecto se comporta igual en cualquier equipo.
            </p>

            <div className="modo" role="group" aria-label="Configuración de los motores">
              <button
                className={`boton pequeno${aislado ? ' activo' : ''}`}
                aria-pressed={aislado}
                disabled={trabajando}
                onClick={() =>
                  void accion(
                    () => api.cambiarConfiguracionPersonal(resumen.project.id, false),
                    'Los motores se lanzarán aislados a partir de la siguiente ejecución.',
                  )
                }
                title="Los agentes no ven tu CLAUDE.md, tus hooks, tus ajustes ni tus servidores MCP."
              >
                Aislada
              </button>
              <button
                className={`boton pequeno${aislado ? '' : ' activo'}`}
                aria-pressed={!aislado}
                disabled={trabajando}
                onClick={() =>
                  void accion(
                    () => api.cambiarConfiguracionPersonal(resumen.project.id, true),
                    'Los motores usarán tu configuración personal a partir de la siguiente ejecución.',
                  )
                }
                title="Los agentes heredan tu CLAUDE.md, tus hooks, tus ajustes y tus servidores MCP."
              >
                La mía
              </button>
            </div>
          </div>

          <div className="bloque">
            <h3>Equipo</h3>
            {agentes.map((agente) => (
              <div key={agente.id} className="hallazgo" data-gravedad="minor">
                <div className="titulo">
                  {agente.name}
                  <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--texto-tenue)' }}>
                    {NOMBRE_ROL[agente.role]}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                  <label style={{ fontSize: 12 }}>
                    Motor{' '}
                    <select
                      value={agente.engine}
                      disabled={trabajando || disponibles.length < 2}
                      onChange={(e) =>
                        void accion(
                          () => api.cambiarMotor(agente.id, e.target.value),
                          `${agente.name} pasa a ejecutarse con ${e.target.value}.`,
                        )
                      }
                    >
                      {disponibles.map((nombre) => (
                        <option key={nombre} value={nombre}>{nombre}</option>
                      ))}
                      {/* El motor que tenga configurado, aunque ya no esté instalado. */}
                      {!disponibles.includes(agente.engine) && (
                        <option value={agente.engine}>{agente.engine} (no instalado)</option>
                      )}
                    </select>
                  </label>

                  <label style={{ fontSize: 12 }}>
                    Workers{' '}
                    <input
                      type="number"
                      min={1}
                      max={8}
                      defaultValue={agente.max_workers}
                      disabled={trabajando}
                      style={{ width: 52 }}
                      onBlur={(e) => {
                        const valor = Number(e.target.value);
                        if (valor !== agente.max_workers) {
                          void accion(
                            () => api.cambiarWorkers(agente.id, valor),
                            `${agente.name} puede tener ${valor} workers a la vez.`,
                          );
                        }
                      }}
                    />
                  </label>

                  <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={agente.enabled !== 0}
                      disabled={trabajando}
                      onChange={(e) =>
                        void accion(
                          () => api.activarAgente(agente.id, e.target.checked),
                          e.target.checked ? `${agente.name} vuelve a recibir trabajo.` : `${agente.name} deja de recibir trabajo.`,
                        )
                      }
                    />
                    Activo
                  </label>
                </div>

                <div className="resolucion">
                  Herramientas: {agente.allowed_tools.join(', ') || 'ninguna'}
                </div>
              </div>
            ))}
          </div>

          {motores && motores.unavailable.length > 0 && (
            <div className="bloque">
              <h3>Motores no disponibles</h3>
              {motores.unavailable.map((m) => (
                <p key={m.engine} style={{ fontSize: 12.5, color: 'var(--texto-suave)' }}>
                  <strong>{m.engine}:</strong> {m.reason}
                </p>
              ))}
            </div>
          )}

          {motores && (
            <div className="bloque">
              <h3>Qué sabe hacer cada motor</h3>
              {motores.available.map((m) => (
                <div key={m.name} style={{ marginBottom: 8 }}>
                  <strong style={{ fontSize: 13 }}>{m.name}</strong>
                  <div style={{ fontSize: 12.5, color: 'var(--texto-suave)' }}>
                    {[
                      m.capabilities.costReporting ? 'informa del coste' : 'no informa del coste',
                      m.capabilities.usageReporting ? 'informa del consumo de la suscripción' : 'no informa del consumo',
                      m.capabilities.resumeSession ? 'continúa sesiones' : 'no continúa sesiones',
                      m.capabilities.stop ? 'se puede parar' : 'no se puede parar',
                    ].join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          )}

          {aviso && <div className="aviso desconectado">{aviso}</div>}
        </div>
      </aside>
    </div>
  );
}

/**
 * Lo que cuesta hablar con el orquestador.
 *
 * El orquestador no continúa ninguna sesión de Claude: en cada mensaje se le manda el
 * estado del proyecto entero. Por eso el tamaño del encargo crece con el número de
 * tareas, y por eso interesa tenerlo a la vista.
 *
 * Se pide al abrir los ajustes, no con el resto del estado, porque no hace falta para
 * nada de lo que se ve en la pantalla principal.
 */
function CosteDelOrquestador({ projectId }: { projectId: string }) {
  const [datos, setDatos] = useState<TurnosDelOrquestador | null>(null);

  useEffect(() => {
    api.turnosDelOrquestador(projectId).then(setDatos).catch(() => setDatos(null));
  }, [projectId]);

  if (!datos || datos.resumen.turnos === 0) return null;

  const { resumen } = datos;
  const miles = (n: number | null) => (n === null ? '—' : n.toLocaleString('es-ES'));

  return (
    <div className="bloque">
      <h3>Lo que cuesta hablar con el orquestador</h3>

      <dl className="lista-datos">
        <dt>Turnos</dt>
        <dd>{resumen.turnos}</dd>
        <dt>Último encargo</dt>
        <dd>{miles(resumen.ultimo_encargo)} caracteres</dd>
        <dt>Encargo medio</dt>
        <dd>{miles(resumen.encargo_medio)} caracteres</dd>
        <dt>Entrada media</dt>
        <dd>{miles(resumen.entrada_media)} tokens</dd>
        <dt>Salida media</dt>
        <dd>{miles(resumen.salida_media)} tokens</dd>
      </dl>

      <p className="nota">
        En cada mensaje tuyo se le manda el estado del proyecto entero, así que el encargo
        crece con el número de tareas. Los tokens solo llegan de los motores que los
        informan.
      </p>
    </div>
  );
}

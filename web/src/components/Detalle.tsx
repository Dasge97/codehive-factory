import { useState } from 'react';
import { api, type SystemEvent, type TaskDetail } from '../api';
import { Estado, haceCuanto, hora } from './Estado';
import { describir } from './Actividad';

interface Props {
  detalle: TaskDetail;
  eventos: SystemEvent[];
  alCerrar: () => void;
  alRecargar: () => void;
  alAbrirTarea: (taskId: string) => void;
}

/**
 * Panel de una tarea.
 *
 * Reúne en un sitio el objetivo, lo que se ha ejecutado, lo que se ha publicado y los
 * hallazgos con su corrección. Así se sigue el hilo completo de un problema sin
 * reconstruirlo a partir de conversaciones sueltas.
 */
export function Detalle({ detalle, eventos, alCerrar, alRecargar, alAbrirTarea }: Props) {
  const { task } = detalle;
  const [trabajando, setTrabajando] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);

  const ejecucionActiva = detalle.runs.find((r) => r.status === 'running');
  const abiertos = detalle.findings.filter((f) => f.status === 'open');
  const pendientes = detalle.approvals.filter((a) => a.status === 'pending');

  async function accion(fn: () => Promise<unknown>, mensajeExito: string) {
    setTrabajando(true);
    setResultado(null);
    try {
      const r = (await fn()) as { reason?: string; integrated?: boolean };
      setResultado(r?.reason ?? mensajeExito);
      alRecargar();
    } catch (e) {
      setResultado(e instanceof Error ? e.message : String(e));
    } finally {
      setTrabajando(false);
    }
  }

  const eventosDeLaTarea = eventos.filter((e) => e.task_id === task.id);

  return (
    <div className="detalle-fondo" onClick={alCerrar}>
      <aside className="detalle" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={task.title}>
        <header>
          <div style={{ flex: 1 }}>
            <h2>{task.title}</h2>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
              <Estado estado={task.status} />
              <span style={{ fontSize: 12, color: 'var(--texto-tenue)' }}>
                {task.kind} · {task.required_role} · prioridad {task.priority}
              </span>
            </div>
          </div>
          <button className="boton pequeno" onClick={alCerrar} aria-label="Cerrar">Cerrar</button>
        </header>

        <div className="contenido">
          {task.blocked_reason && (
            <div className="aviso">
              <strong>Bloqueada.</strong> {task.blocked_reason}
            </div>
          )}

          {detalle.waiting_for && (
            <div className="aviso desconectado">
              <strong>Esperando.</strong> {detalle.waiting_for}
            </div>
          )}

          {pendientes.map((a) => (
            <div className="aviso" key={a.id}>
              <div>
                <strong>Necesita tu permiso.</strong> {a.request}
                {a.tool_input && (
                  <div style={{ fontSize: 12, marginTop: 4, fontFamily: 'var(--fuente-mono)' }}>
                    {a.tool_input.slice(0, 200)}
                  </div>
                )}
              </div>
              <div className="acciones">
                <button
                  className="boton pequeno"
                  disabled={trabajando}
                  onClick={() => void accion(() => api.responderAutorizacion(a.id, false), 'Denegado.')}
                >
                  Denegar
                </button>
                <button
                  className="boton pequeno principal"
                  disabled={trabajando}
                  onClick={() => void accion(() => api.responderAutorizacion(a.id, true), 'Concedido.')}
                >
                  Permitir
                </button>
              </div>
            </div>
          ))}

          <div className="bloque">
            <h3>Objetivo</h3>
            <p>{task.goal}</p>
            {task.scope && (
              <>
                <h3 style={{ marginTop: 10 }}>Alcance</h3>
                <p>{task.scope}</p>
              </>
            )}
            {task.acceptance && (
              <>
                <h3 style={{ marginTop: 10 }}>Criterios de aceptación</h3>
                <p>{task.acceptance}</p>
              </>
            )}
          </div>

          {detalle.dependencies.length > 0 && (
            <div className="bloque">
              <h3>Depende de</h3>
              {detalle.dependencies.map((d) => (
                <button
                  key={d.id}
                  className="boton pequeno"
                  style={{ marginRight: 6, marginBottom: 6 }}
                  onClick={() => alAbrirTarea(d.id)}
                >
                  {d.title} · <Estado estado={d.status} />
                </button>
              ))}
            </div>
          )}

          {detalle.locks.length > 0 && (
            <div className="bloque">
              <h3>Ficheros reservados</h3>
              <div>
                {detalle.locks.map((l) => (
                  <span key={l.id} className="commit" style={{ marginRight: 6 }}>
                    {l.path_pattern}
                    {l.released_at ? ' (liberado)' : ''}
                  </span>
                ))}
              </div>
            </div>
          )}

          {detalle.findings.length > 0 && (
            <div className="bloque">
              <h3>Hallazgos</h3>
              {detalle.findings.map((f) => (
                <div
                  key={f.id}
                  className={`hallazgo${f.status !== 'open' ? ' resuelto' : ''}`}
                  data-gravedad={f.severity}
                >
                  <div className="titulo">
                    {f.title}
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--texto-tenue)' }}>
                      {f.severity} · {f.status === 'open' ? 'abierto' : 'resuelto'}
                    </span>
                  </div>
                  <div>{f.detail}</div>
                  {f.file_path && (
                    <div style={{ marginTop: 4 }}>
                      <span className="commit">
                        {f.file_path}
                        {f.line ? `:${f.line}` : ''}
                      </span>
                    </div>
                  )}
                  <div className="resolucion">Se da por resuelto cuando: {f.resolution}</div>
                  {f.fix_task_id && (
                    <button
                      className="boton pequeno"
                      style={{ marginTop: 8 }}
                      onClick={() => alAbrirTarea(f.fix_task_id!)}
                    >
                      Ver la corrección
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {detalle.increments.length > 0 && (
            <div className="bloque">
              <h3>Incrementos publicados</h3>
              {detalle.increments.map((i) => {
                const ficheros = i.files_json ? (JSON.parse(i.files_json) as string[]) : [];
                return (
                  <div key={i.id} style={{ marginBottom: 10 }}>
                    <div>
                      <span className="commit">{i.commit_sha.slice(0, 8)}</span> {i.message}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--texto-tenue)' }}>
                      {i.review_status === 'approved'
                        ? 'Revisado y aprobado'
                        : i.review_status === 'rejected'
                          ? 'Revisado con hallazgos'
                          : 'Pendiente de revisar'}
                      {ficheros.length > 0 && ` · ${ficheros.length} ficheros`}
                      {' · '}
                      {haceCuanto(i.created_at)}
                    </div>
                    {ficheros.length > 0 && (
                      <details style={{ marginTop: 4 }}>
                        <summary>Ver ficheros</summary>
                        <div className="registro">{ficheros.join('\n')}</div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="bloque">
            <h3>Ejecuciones</h3>
            {detalle.runs.length === 0 ? (
              <p style={{ color: 'var(--texto-tenue)' }}>Todavía no se ha ejecutado.</p>
            ) : (
              detalle.runs.map((r) => (
                <div key={r.id} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>{ESTADO_EJECUCION[r.status] ?? r.status}</strong>
                    <span style={{ fontSize: 12, color: 'var(--texto-tenue)' }}>
                      {hora(r.started_at)}
                      {r.cost_usd !== null && ` · ${r.cost_usd.toFixed(4)} $`}
                      {r.input_tokens !== null && ` · ${r.input_tokens + (r.output_tokens ?? 0)} tokens`}
                    </span>
                    {r.status === 'running' && (
                      <button
                        className="boton pequeno peligro"
                        disabled={trabajando}
                        onClick={() =>
                          void accion(() => api.pararEjecucion(r.id), 'Parada solicitada. Espera la confirmación.')
                        }
                      >
                        Parar
                      </button>
                    )}
                  </div>
                  {r.summary && <div style={{ fontSize: 13 }}>{r.summary}</div>}
                  {r.error && <div style={{ fontSize: 13, color: 'var(--blocked)' }}>{r.error}</div>}
                </div>
              ))
            )}
          </div>

          <div className="bloque">
            <h3>Datos</h3>
            <dl className="lista-datos">
              <dt>Identificador</dt>
              <dd className="commit">{task.id}</dd>
              {task.branch && (
                <>
                  <dt>Rama</dt>
                  <dd className="commit">{task.branch}</dd>
                </>
              )}
              {task.head_commit && (
                <>
                  <dt>Último commit</dt>
                  <dd className="commit">{task.head_commit.slice(0, 8)}</dd>
                </>
              )}
              <dt>Intentos</dt>
              <dd>{task.attempts}</dd>
              <dt>Actualizada</dt>
              <dd>{haceCuanto(task.updated_at)}</dd>
            </dl>
          </div>

          {eventosDeLaTarea.length > 0 && (
            <div className="bloque">
              <details>
                <summary>Registro detallado ({eventosDeLaTarea.length} eventos)</summary>
                <div className="registro" style={{ marginTop: 8 }}>
                  {eventosDeLaTarea
                    .map((e) => `${hora(e.created_at)}  ${describir(e) ?? `${e.type}: ${e.payload}`}`)
                    .join('\n')}
                </div>
              </details>
            </div>
          )}

          {resultado && <div className="aviso desconectado">{resultado}</div>}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingBottom: 20 }}>
            {detalle.integrable.ready && (
              <button
                className="boton principal"
                disabled={trabajando}
                onClick={() => {
                  const confirmado = window.confirm(
                    `Se va a fusionar la rama ${task.branch} en la principal y después se ejecutarán las verificaciones del proyecto. ¿Sigo?`,
                  );
                  if (confirmado) void accion(() => api.integrar(task.id), 'Integrada.');
                }}
              >
                Integrar en la rama principal
              </button>
            )}

            {!detalle.integrable.ready && detalle.integrable.reason && (
              <span style={{ fontSize: 12, color: 'var(--texto-tenue)', alignSelf: 'center' }}>
                No se puede integrar: {detalle.integrable.reason}
              </span>
            )}

            {task.status !== 'done' && task.status !== 'cancelled' && (
              <>
                <button
                  className="boton"
                  disabled={trabajando}
                  onClick={() =>
                    void accion(() => api.cambiarPrioridad(task.id, Math.max(1, task.priority - 20)), 'Prioridad subida.')
                  }
                >
                  Subir prioridad
                </button>
                <button
                  className="boton peligro"
                  disabled={trabajando}
                  onClick={() => {
                    const motivo = window.prompt('¿Por qué cancelas esta tarea?');
                    if (motivo) void accion(() => api.cancelar(task.id, motivo), 'Cancelada.');
                  }}
                >
                  Cancelar tarea
                </button>
              </>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

const ESTADO_EJECUCION: Record<string, string> = {
  running: 'En marcha',
  succeeded: 'Terminada bien',
  failed: 'Fallida',
  cancelled: 'Cancelada',
  interrupted: 'Interrumpida',
  timed_out: 'Tiempo agotado',
};

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  useEventos,
  type AgentView,
  type ChatMessage,
  type MotoresDisponibles,
  type ProjectOverview,
  type SystemEvent,
  type Task,
  type TaskDetail,
} from './api';
import { Actividad } from './components/Actividad';
import { Ajustes } from './components/Ajustes';
import { Cabecera } from './components/Cabecera';
import { Chat } from './components/Chat';
import { Detalle } from './components/Detalle';
import { PanelAgente, pasosPorAgente } from './components/PanelAgente';
import { Recorrido, pasoDeLaTarea, type PasoId } from './components/Recorrido';
import { Tablero, TrabajoDelProyecto } from './components/Tareas';

type SeccionMovil = 'pedir' | 'equipo' | 'trabajo';

export function App() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [resumen, setResumen] = useState<ProjectOverview | null>(null);
  const [tareas, setTareas] = useState<Task[]>([]);
  const [agentes, setAgentes] = useState<AgentView[]>([]);
  const [mensajes, setMensajes] = useState<ChatMessage[]>([]);
  const [eventos, setEventos] = useState<SystemEvent[]>([]);
  const [detalle, setDetalle] = useState<TaskDetail | null>(null);
  const [motores, setMotores] = useState<MotoresDisponibles | null>(null);

  const [ajustesAbiertos, setAjustesAbiertos] = useState(false);
  const [seccion, setSeccion] = useState<SeccionMovil>('pedir');
  const [paso, setPaso] = useState<PasoId | 'atascado' | null>(null);
  const [verTablero, setVerTablero] = useState(false);
  // El borrador vive aquí para que no se pierda al cambiar de sección en el móvil.
  const [borrador, setBorrador] = useState('');
  const [tema, setTema] = useState<'sistema' | 'claro' | 'oscuro'>('sistema');
  const [paradaPedida, setParadaPedida] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tareaAbierta = useRef<string | null>(null);

  // ---------------------------------------------------------------- carga

  useEffect(() => {
    api
      .proyectos()
      .then((lista) => {
        if (lista.length === 0) {
          setError('No hay ningún proyecto registrado.');
          return;
        }
        setProjectId(lista[0]!.id);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const recargarTodo = useCallback(async () => {
    if (!projectId) return;
    try {
      const [r, t, a, c, ev] = await Promise.all([
        api.proyecto(projectId),
        api.tareas(projectId),
        api.agentes(projectId),
        api.chat(projectId),
        // Los pasos de cada agente salen de aquí, así que hace falta bastante historial.
        api.actividad(projectId, 200),
      ]);
      setResumen(r);
      setTareas(t);
      setAgentes(a);
      setMensajes(c);
      setEventos(ev);
      setError(null);
      if (!r.orchestrator_busy) setParadaPedida(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void recargarTodo();
  }, [recargarTodo]);

  // Los motores instalados no cambian mientras el sistema está en marcha, así que se
  // piden una sola vez.
  useEffect(() => {
    api.motores().then(setMotores).catch(() => setMotores(null));
  }, []);

  const recargarDetalle = useCallback(async () => {
    const id = tareaAbierta.current;
    if (!id) return;
    try {
      setDetalle(await api.detalle(id));
    } catch {
      setDetalle(null);
    }
  }, []);

  // ------------------------------------------------------------- eventos

  const conexion = useEventos(projectId, (evento) => {
    // Cada evento entra en la lista: es lo que alimenta el panel de cada agente.
    setEventos((previos) => [evento, ...previos].slice(0, 400));

    if (evento.type === 'chat.message') {
      void api.chat(evento.project_id).then(setMensajes).catch(() => undefined);
      void recargarTodo();
    } else if (evento.type !== 'run.progress') {
      // Un paso suelto no cambia el estado del trabajo, así que no hace falta volver a
      // pedirlo todo cada vez: ya se ve en el panel del agente.
      void recargarTodo();
      if (evento.task_id === tareaAbierta.current) void recargarDetalle();
    }
  });

  // ---------------------------------------------------------------- tema

  useEffect(() => {
    const raiz = document.documentElement;
    if (tema === 'sistema') raiz.removeAttribute('data-tema');
    else raiz.setAttribute('data-tema', tema);
  }, [tema]);

  // -------------------------------------------------------------- acciones

  async function abrirTarea(taskId: string) {
    tareaAbierta.current = taskId;
    try {
      setDetalle(await api.detalle(taskId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function cerrarDetalle() {
    tareaAbierta.current = null;
    setDetalle(null);
  }

  async function enviarMensaje(texto: string) {
    if (!projectId) return;
    await api.enviarMensaje(projectId, texto);
    setMensajes(await api.chat(projectId));
  }

  // -------------------------------------------------------------- derivados

  const integrables = useMemo(() => resumen?.integrable.map((t) => t.id) ?? [], [resumen]);
  const pasos = useMemo(() => pasosPorAgente(eventos), [eventos]);

  const tareasDelPaso = useMemo(() => {
    if (!paso) return tareas;
    const conjunto = new Set(integrables);
    return tareas.filter((t) => pasoDeLaTarea(t, conjunto) === paso);
  }, [tareas, paso, integrables]);

  const orquestador = agentes.find((a) => a.role === 'orchestrator');
  const equipo = agentes.filter((a) => a.role !== 'orchestrator');

  // El servidor dice si el orquestador tiene un turno en marcha; la web no lo adivina.
  const orquestadorPensando = resumen?.orchestrator_busy ?? false;

  // Lo último que se le ha visto hacer, para que la espera no sea un texto fijo.
  const ultimoPasoOrquestador = orquestador
    ? (pasos.get(orquestador.id)?.at(-1)?.texto ?? null)
    : null;

  // ---------------------------------------------------------------- render

  if (error && !resumen) {
    return (
      <div className="app">
        <div className="cuerpo">
          <div className="aviso">{error}</div>
        </div>
      </div>
    );
  }

  if (!resumen) {
    return (
      <div className="app">
        <p className="vacio">Cargando…</p>
      </div>
    );
  }

  const autorizaciones = resumen.snapshot.pending_approvals;
  const uso = resumen.usage.find((u) => u.engine === 'claude_code');
  const atascadas = tareas.filter((t) => t.status === 'blocked').length;

  return (
    <div className="app">
      <Cabecera
        resumen={resumen}
        agentes={agentes}
        tema={tema}
        alCambiarTema={() => setTema(tema === 'oscuro' ? 'claro' : tema === 'claro' ? 'sistema' : 'oscuro')}
        alAbrirAjustes={() => setAjustesAbiertos(true)}
      />

      <Recorrido
        tareas={tareas}
        integrables={integrables}
        pasoSeleccionado={paso}
        alSeleccionar={(p) => {
          setPaso(p);
          setSeccion('trabajo');
        }}
      />

      <div className="avisos">
        {conexion === 'desconectado' && (
          <div className="aviso desconectado">
            Sin conexión con el servicio. Lo que ves puede estar desactualizado.
          </div>
        )}

        {resumen.project.status === 'paused' && (
          <div className="aviso desconectado">
            El proyecto está en pausa. El trabajo en curso termina y no se arranca nada nuevo.
            <div className="acciones">
              <button
                className="boton pequeno"
                onClick={() => void api.pausarProyecto(resumen.project.id, false).then(recargarTodo)}
              >
                Reanudar
              </button>
            </div>
          </div>
        )}

        {autorizaciones.length > 0 && (
          <div className="aviso">
            <span>
              {autorizaciones.length === 1
                ? 'Un agente necesita tu permiso para seguir.'
                : `${autorizaciones.length} agentes necesitan tu permiso para seguir.`}
            </span>
            <div className="acciones">
              <button className="boton pequeno" onClick={() => void abrirTarea(autorizaciones[0]!.task_id)}>
                Ver
              </button>
            </div>
          </div>
        )}

        {resumen.integrable.length > 0 && (
          <div className="aviso listo">
            <span>
              {resumen.integrable.length === 1
                ? 'Hay trabajo revisado esperando a que lo integres.'
                : `Hay ${resumen.integrable.length} trabajos revisados esperando a que los integres.`}
            </span>
            <div className="acciones">
              <button className="boton pequeno" onClick={() => void abrirTarea(resumen.integrable[0]!.id)}>
                Ver
              </button>
            </div>
          </div>
        )}

        {uso?.status === 'exhausted' && (
          <div className="aviso">
            El motor se ha quedado sin cuota. Las tareas afectadas están en pausa y conservan su estado.
          </div>
        )}
      </div>

      <div className="cuerpo" data-seccion={seccion}>
        <div className="columna-equipo izquierda">
          {equipo.slice(0, 2).map((agente) => (
            <PanelAgente
              key={agente.id}
              agente={agente}
              tareas={tareas}
              pasos={pasos.get(agente.id) ?? []}
              alAbrirTarea={(id) => void abrirTarea(id)}
            />
          ))}
        </div>

        <div className="columna-centro">
          <Chat
            mensajes={mensajes}
            alEnviar={enviarMensaje}
            borrador={borrador}
            alCambiarBorrador={setBorrador}
            proyecto={resumen.project}
            pensando={orquestadorPensando}
            ultimoPaso={ultimoPasoOrquestador}
            paradaPedida={paradaPedida}
            alParar={() => {
              setParadaPedida(true);
              void api.pararOrquestador(resumen.project.id).catch(() => setParadaPedida(false));
            }}
          />

          {orquestador && (pasos.get(orquestador.id)?.length ?? 0) > 0 && (
            <PanelAgente
              agente={orquestador}
              tareas={tareas}
              pasos={pasos.get(orquestador.id) ?? []}
              alAbrirTarea={(id) => void abrirTarea(id)}
              compacto
            />
          )}
        </div>

        <div className="columna-equipo derecha">
          {equipo.slice(2).map((agente) => (
            <PanelAgente
              key={agente.id}
              agente={agente}
              tareas={tareas}
              pasos={pasos.get(agente.id) ?? []}
              alAbrirTarea={(id) => void abrirTarea(id)}
            />
          ))}
        </div>

        <div className="columna-trabajo">
          {verTablero ? (
            <>
              <Tablero tareas={tareas} alAbrir={(id) => void abrirTarea(id)} />
              <button className="boton pequeno" onClick={() => setVerTablero(false)}>
                Volver a la lista
              </button>
            </>
          ) : (
            <TrabajoDelProyecto
              tareas={tareasDelPaso}
              agentes={agentes}
              agenteSeleccionado={null}
              alAbrir={(id) => void abrirTarea(id)}
              filtro={paso ? { paso, alQuitar: () => setPaso(null) } : null}
              accionExtra={
                <button className="boton pequeno" onClick={() => setVerTablero(true)}>
                  Ver por estados
                </button>
              }
            />
          )}

          <Actividad eventos={eventos} alAbrirTarea={(id) => void abrirTarea(id)} />
        </div>
      </div>

      <nav className="nav-movil">
        <button aria-current={seccion === 'pedir' ? 'page' : undefined} onClick={() => setSeccion('pedir')}>
          Pedir
          {autorizaciones.length > 0 && <span className="senal" title="Hay algo que decidir" />}
        </button>
        <button aria-current={seccion === 'equipo' ? 'page' : undefined} onClick={() => setSeccion('equipo')}>
          Equipo
        </button>
        <button aria-current={seccion === 'trabajo' ? 'page' : undefined} onClick={() => setSeccion('trabajo')}>
          Trabajo
          {atascadas > 0 && <span className="senal" title={`${atascadas} tareas atascadas`} />}
        </button>
      </nav>

      {ajustesAbiertos && (
        <Ajustes
          resumen={resumen}
          agentes={agentes}
          motores={motores}
          alCerrar={() => setAjustesAbiertos(false)}
          alRecargar={() => void recargarTodo()}
        />
      )}

      {detalle && (
        <Detalle
          detalle={detalle}
          eventos={eventos}
          alCerrar={cerrarDetalle}
          alRecargar={() => {
            void recargarDetalle();
            void recargarTodo();
          }}
          alAbrirTarea={(id) => void abrirTarea(id)}
        />
      )}
    </div>
  );
}

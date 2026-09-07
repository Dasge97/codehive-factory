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
import { AbrirCarpeta } from './components/AbrirCarpeta';
import { Ajustes } from './components/Ajustes';
import { Cabecera } from './components/Cabecera';
import { Chat } from './components/Chat';
import { Detalle } from './components/Detalle';
import { PanelAgente, pasosPorAgente } from './components/PanelAgente';
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
  const [carpetaAbierta, setCarpetaAbierta] = useState(false);
  // El trabajo vive en un cajón lateral que se abre cuando hace falta: el sitio de la
  // pantalla es para los agentes.
  const [trabajoAbierto, setTrabajoAbierto] = useState(false);
  const [seccion, setSeccion] = useState<SeccionMovil>('pedir');
  // Todos los agentes ocupan lo mismo. El que pulsas crece y se pone delante; los demás
  // se quedan atenuados detrás, para poder leer o escribir sin que estorbe el resto.
  const [foco, setFoco] = useState<string | null>(null);
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
        // Solo una carpeta trabaja a la vez. Se abre la que está en marcha, no la primera
        // de la lista, que podría ser una que se dejó en pausa hace días.
        setProjectId((lista.find((p) => p.status === 'active') ?? lista[0]!).id);
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

  // --------------------------------------------------------------- foco

  useEffect(() => {
    function alPulsar(evento: KeyboardEvent) {
      if (evento.key === 'Escape') setFoco(null);
    }
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, []);

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

  const pasos = useMemo(() => pasosPorAgente(eventos), [eventos]);

  const orquestador = agentes.find((a) => a.role === 'orchestrator');
  const equipo = agentes.filter((a) => a.role !== 'orchestrator');

  // El chat es el panel del orquestador. Si el proyecto todavía no tiene ninguno, la caja
  // sigue estando y se puede enfocar igual.
  const idDelChat = orquestador?.id ?? 'chat';

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
  const abiertas = tareas.filter((t) => t.status !== 'cancelled' && t.status !== 'done').length;
  const atascadas = tareas.filter((t) => t.status === 'blocked').length;

  return (
    <div className="app">
      <Cabecera
        resumen={resumen}
        agentes={agentes}
        tema={tema}
        alCambiarTema={() => setTema(tema === 'oscuro' ? 'claro' : tema === 'claro' ? 'sistema' : 'oscuro')}
        alAbrirAjustes={() => setAjustesAbiertos(true)}
        trabajoAbierto={trabajoAbierto}
        alAlternarTrabajo={() => setTrabajoAbierto((v) => !v)}
        tareasAbiertas={abiertas}
        tareasAtascadas={atascadas}
        listasParaIntegrar={resumen.integrable.length}
        alCambiarModo={(modo) => void api.cambiarModo(resumen.project.id, modo).then(recargarTodo)}
        alAbrirCarpeta={() => setCarpetaAbierta(true)}
        alQuitarFoco={() => setFoco(null)}
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

      {/*
        Una sola rejilla: cada agente ocupa lo mismo, el orquestador incluido. Pulsar en
        el hueco entre paneles quita el foco y todos vuelven a verse igual.
      */}
      <div
        className={`cuerpo${foco ? ' con-foco' : ''}`}
        data-seccion={seccion}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setFoco(null);
        }}
      >
        <Chat
          mensajes={mensajes}
          alEnviar={enviarMensaje}
          borrador={borrador}
          alCambiarBorrador={setBorrador}
          proyecto={resumen.project}
          pensando={orquestadorPensando}
          ultimoPaso={ultimoPasoOrquestador}
          paradaPedida={paradaPedida}
          agente={orquestador ?? null}
          enfocado={foco === idDelChat}
          alEnfocar={() => setFoco(idDelChat)}
          alParar={() => {
            setParadaPedida(true);
            void api.pararOrquestador(resumen.project.id).catch(() => setParadaPedida(false));
          }}
        />

        {equipo.map((agente) => (
          <PanelAgente
            key={agente.id}
            agente={agente}
            tareas={tareas}
            pasos={pasos.get(agente.id) ?? []}
            alAbrirTarea={(id) => void abrirTarea(id)}
            enfocado={foco === agente.id}
            alEnfocar={() => setFoco(agente.id)}
          />
        ))}
      </div>

      {/*
        El estado del trabajo vive en un cajón: se consulta cuando hace falta y no roba
        sitio a los agentes el resto del tiempo.
      */}
      {trabajoAbierto && (
        <div className="cajon-fondo" onClick={() => setTrabajoAbierto(false)}>
          <aside className="cajon" onClick={(e) => e.stopPropagation()} aria-label="Trabajo del proyecto">
            <header>
              <h2>Trabajo del proyecto</h2>
              <button className="boton pequeno" onClick={() => setTrabajoAbierto(false)}>
                Cerrar el trabajo
              </button>
            </header>

            <div className="cajon-contenido">
              {verTablero ? (
                <>
                  <Tablero tareas={tareas} alAbrir={(id) => void abrirTarea(id)} />
                  <button className="boton pequeno" onClick={() => setVerTablero(false)}>
                    Volver a la lista
                  </button>
                </>
              ) : (
                <TrabajoDelProyecto
                  tareas={tareas}
                  agentes={agentes}
                  agenteSeleccionado={null}
                  alAbrir={(id) => void abrirTarea(id)}
                  accionExtra={
                    <button className="boton pequeno" onClick={() => setVerTablero(true)}>
                      Ver por estados
                    </button>
                  }
                />
              )}

              <Actividad eventos={eventos} alAbrirTarea={(id) => void abrirTarea(id)} />
            </div>
          </aside>
        </div>
      )}

      <nav className="nav-movil">
        <button aria-current={seccion === 'pedir' ? 'page' : undefined} onClick={() => setSeccion('pedir')}>
          Pedir
          {autorizaciones.length > 0 && <span className="senal" title="Hay algo que decidir" />}
        </button>
        <button aria-current={seccion === 'equipo' ? 'page' : undefined} onClick={() => setSeccion('equipo')}>
          Equipo
        </button>
        <button
          aria-current={trabajoAbierto ? 'page' : undefined}
          onClick={() => setTrabajoAbierto(true)}
        >
          Trabajo
          {atascadas > 0 && <span className="senal" title={`${atascadas} tareas atascadas`} />}
        </button>
      </nav>

      {carpetaAbierta && (
        <AbrirCarpeta
          rutaActual={resumen.project.repo_path}
          alCerrar={() => setCarpetaAbierta(false)}
          alAbrir={(proyecto) => {
            setCarpetaAbierta(false);
            // Cambiar de proyecto vacía lo que se veía de la carpeta anterior. Recargarlo
            // todo lo repuebla, pero mientras tanto no se enseñan datos de otra carpeta.
            setTareas([]);
            setAgentes([]);
            setMensajes([]);
            setEventos([]);
            setFoco(null);
            setProjectId(proyecto.id);
          }}
        />
      )}

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

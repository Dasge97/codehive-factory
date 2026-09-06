import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  useEventos,
  type AgentView,
  type ChatMessage,
  type EngineUsage,
  type ProjectOverview,
  type SystemEvent,
  type Task,
  type TaskDetail,
} from './api';
import { Actividad } from './components/Actividad';
import { Chat } from './components/Chat';
import { Detalle } from './components/Detalle';
import { Equipo } from './components/Equipo';
import { Tablero, TrabajoDelProyecto } from './components/Tareas';

type Vista = 'equipo' | 'tablero';
type SeccionMovil = 'equipo' | 'tareas' | 'chat';

export function App() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [resumen, setResumen] = useState<ProjectOverview | null>(null);
  const [tareas, setTareas] = useState<Task[]>([]);
  const [agentes, setAgentes] = useState<AgentView[]>([]);
  const [mensajes, setMensajes] = useState<ChatMessage[]>([]);
  const [eventos, setEventos] = useState<SystemEvent[]>([]);
  const [detalle, setDetalle] = useState<TaskDetail | null>(null);

  const [vista, setVista] = useState<Vista>('equipo');
  const [seccion, setSeccion] = useState<SeccionMovil>('equipo');
  const [agenteSeleccionado, setAgenteSeleccionado] = useState<string | null>(null);
  // El borrador vive aquí para que no se pierda al cambiar de sección en el móvil.
  const [borrador, setBorrador] = useState('');
  const [tema, setTema] = useState<'sistema' | 'claro' | 'oscuro'>('sistema');
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
        api.actividad(projectId),
      ]);
      setResumen(r);
      setTareas(t);
      setAgentes(a);
      setMensajes(c);
      setEventos(ev);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void recargarTodo();
  }, [recargarTodo]);

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
    setEventos((previos) => [evento, ...previos].slice(0, 200));

    // Un evento que cambia el trabajo obliga a volver a pedir lo que se ve. Es más simple
    // y más fiable que ir aplicando cada cambio a mano sobre lo que ya está en pantalla.
    if (evento.type === 'chat.message') {
      void api.chat(evento.project_id).then(setMensajes).catch(() => undefined);
    } else if (evento.type !== 'run.progress') {
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

  const bloqueadas = tareas.filter((t) => t.status === 'blocked').length;
  const autorizaciones = resumen.snapshot.pending_approvals;
  const uso = resumen.usage.find((u) => u.engine === 'claude_code');

  return (
    <div className="app">
      <header className="cabecera">
        <h1>Code Hive Factory</h1>
        <span className="objetivo">
          {resumen.project.name}
          {resumen.snapshot.goal ? ` · ${resumen.snapshot.goal}` : ' · sin objetivo escrito todavía'}
        </span>

        <div className="cabecera-acciones">
          <Consumo uso={uso} />

          <div className="pestanas">
            <button aria-pressed={vista === 'equipo'} onClick={() => setVista('equipo')}>
              Equipo
            </button>
            <button aria-pressed={vista === 'tablero'} onClick={() => setVista('tablero')}>
              Tablero
            </button>
          </div>

          <button
            className="boton pequeno"
            onClick={() => setTema(tema === 'oscuro' ? 'claro' : tema === 'claro' ? 'sistema' : 'oscuro')}
            title="Cambiar entre tema claro, oscuro y el del sistema"
          >
            {tema === 'sistema' ? 'Tema del sistema' : tema === 'claro' ? 'Tema claro' : 'Tema oscuro'}
          </button>
        </div>
      </header>

      <div className="cuerpo" data-seccion={seccion}>
        <div className="columna-principal">
          {conexion === 'desconectado' && (
            <div className="aviso desconectado">
              Sin conexión con el servicio. Lo que ves puede estar desactualizado.
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

          {uso?.status === 'exhausted' && (
            <div className="aviso">
              El motor se ha quedado sin cuota. Las tareas afectadas están en pausa y conservan su estado.
            </div>
          )}

          {vista === 'equipo' ? (
            <>
              <Equipo
                agentes={agentes}
                tareas={tareas}
                seleccionado={agenteSeleccionado}
                alSeleccionar={setAgenteSeleccionado}
              />
              <TrabajoDelProyecto
                tareas={tareas}
                agentes={agentes}
                agenteSeleccionado={agenteSeleccionado}
                alAbrir={(id) => void abrirTarea(id)}
              />
              <Actividad eventos={eventos} alAbrirTarea={(id) => void abrirTarea(id)} />
            </>
          ) : (
            <Tablero tareas={tareas} alAbrir={(id) => void abrirTarea(id)} />
          )}
        </div>

        <div className="columna-lateral">
          <Chat
            mensajes={mensajes}
            alEnviar={enviarMensaje}
            borrador={borrador}
            alCambiarBorrador={setBorrador}
          />
        </div>
      </div>

      <nav className="nav-movil">
        <button
          aria-current={seccion === 'equipo' ? 'page' : undefined}
          onClick={() => {
            setSeccion('equipo');
            setVista('equipo');
          }}
        >
          Equipo
        </button>
        <button
          aria-current={seccion === 'tareas' ? 'page' : undefined}
          onClick={() => {
            setSeccion('tareas');
            setVista('tablero');
          }}
        >
          Tareas
          {bloqueadas > 0 && <span className="senal" title={`${bloqueadas} tareas bloqueadas`} />}
        </button>
        <button
          aria-current={seccion === 'chat' ? 'page' : undefined}
          onClick={() => setSeccion('chat')}
        >
          Chat
          {autorizaciones.length > 0 && <span className="senal" title="Hay algo que decidir" />}
        </button>
      </nav>

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
    <div className="consumo" title={`Consumo de la suscripción${reinicio ? `. Se reinicia a las ${reinicio}` : ''}`}>
      <span>Cuota {porcentaje}%</span>
      <span className="barra-consumo">
        <span style={{ width: `${Math.min(100, porcentaje)}%` }} />
      </span>
    </div>
  );
}

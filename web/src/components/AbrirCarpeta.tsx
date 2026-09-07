import { useCallback, useEffect, useState } from 'react';
import { NecesitaConfirmar, api, type CarpetaListada, type ProyectoRegistrado } from '../api';

interface Props {
  /** Carpeta que está abierta ahora, por la que empieza el explorador. */
  rutaActual: string;
  alCerrar: () => void;
  alAbrir: (proyecto: ProyectoRegistrado) => void;
}

/**
 * Elegir sobre qué carpeta trabaja el equipo.
 *
 * Solo se puede abrir una carpeta que sea un repositorio de Git, así que las que lo son
 * se marcan en la lista y las demás sirven únicamente para seguir bajando.
 *
 * Las carpetas ya abiertas alguna vez aparecen arriba: volver a una es un clic, y al
 * volver siguen su equipo, sus tareas y su conversación donde estaban.
 */
export function AbrirCarpeta({ rutaActual, alCerrar, alAbrir }: Props) {
  const [carpeta, setCarpeta] = useState<CarpetaListada | null>(null);
  const [recientes, setRecientes] = useState<ProyectoRegistrado[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  // Una carpeta con miles de ficheros se puede abrir igual, pero antes se dice lo que va a
  // pasar: el primer commit se los lleva todos y tarda minutos.
  const [confirmar, setConfirmar] = useState<{ ruta: string; mensaje: string } | null>(null);

  const explorar = useCallback(async (ruta?: string) => {
    setAviso(null);
    try {
      setCarpeta(await api.explorar(ruta));
    } catch (e) {
      setAviso(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    // Se empieza por la carpeta de arriba de la que está abierta: casi siempre la de al
    // lado es la que se busca.
    void explorar(rutaActual);
    api.proyectos().then(setRecientes).catch(() => setRecientes([]));
  }, [explorar, rutaActual]);

  /**
   * Abre el diálogo de carpetas del sistema, que sale en el equipo donde corre el servicio.
   *
   * Tarda unos segundos en aparecer: hay que arrancar PowerShell y montar la ventana. El
   * aviso lo dice, porque si no parece que el botón no ha hecho nada.
   */
  async function elegirEnElEquipo() {
    setTrabajando(true);
    setAviso(
      'Abriendo el explorador de Windows en el equipo donde corre el sistema. Tarda unos segundos en aparecer.',
    );
    try {
      const elegida = await api.selectorNativo(carpeta?.path);
      if (elegida.path) {
        await abrir(elegida.path);
        return;
      }
      setAviso(null);
    } catch (e) {
      setAviso(e instanceof Error ? e.message : String(e));
    } finally {
      setTrabajando(false);
    }
  }

  async function abrir(ruta: string, confirmado = false) {
    setTrabajando(true);
    setAviso(null);
    setConfirmar(null);
    try {
      alAbrir(await api.abrirCarpeta(ruta, confirmado));
    } catch (e) {
      if (e instanceof NecesitaConfirmar) {
        setConfirmar({ ruta, mensaje: e.message });
      } else {
        setAviso(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setTrabajando(false);
    }
  }

  return (
    // Este panel entra por la izquierda. Los demás paneles laterales salen por la derecha,
    // y elegir carpeta no es lo mismo que consultar algo del proyecto abierto: es cambiar
    // de proyecto, así que se distingue también por el lado del que aparece.
    <div className="detalle-fondo izquierda" onClick={alCerrar}>
      <aside
        className="detalle izquierda"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Abrir carpeta"
      >
        <header>
          <h2>Abrir carpeta</h2>
          <button className="boton pequeno" onClick={alCerrar}>Cerrar</button>
        </header>

        <div className="contenido">
          {aviso && <div className="aviso desconectado">{aviso}</div>}

          {confirmar && (
            <div className="aviso">
              <span>
                {confirmar.mensaje} Tardará varios minutos y dejará todo dentro del
                repositorio. Si la carpeta tiene varios proyectos sueltos, o dependencias
                sin ignorar, seguramente quieras abrir una carpeta más concreta.
              </span>
              <div className="acciones">
                <button
                  className="boton pequeno"
                  disabled={trabajando}
                  onClick={() => void abrir(confirmar.ruta, true)}
                >
                  Abrirla igualmente
                </button>
                <button className="boton pequeno" onClick={() => setConfirmar(null)}>
                  Dejarlo
                </button>
              </div>
            </div>
          )}

          {recientes.length > 0 && (
            <div className="bloque">
              <h3>Carpetas que ya has abierto</h3>
              <ul className="lista-carpetas">
                {recientes.map((p) => (
                  <li key={p.id}>
                    <button
                      className="carpeta"
                      disabled={trabajando}
                      onClick={() => void abrir(p.repo_path)}
                      title={p.repo_path}
                    >
                      <span className="nombre">{p.name}</span>
                      <span className="commit">{p.repo_path}</span>
                      {p.repo_path === rutaActual && <span className="etiqueta">abierta</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="bloque">
            <h3>Buscar en el disco</h3>
            <p style={{ fontSize: 12.5, color: 'var(--texto-suave)' }}>
              Se puede abrir cualquier carpeta. Las marcadas como repositorio ya lo son; en
              las demás se crea uno al abrirlas.
            </p>
            <p style={{ fontSize: 12.5, color: 'var(--texto-suave)' }}>
              El explorador de Windows se abre en el equipo donde corre el sistema. Desde el
              móvil no lo verás, así que ahí tienes que navegar con los botones de abajo.
            </p>

            {carpeta?.native_picker && (
              <button
                className="boton"
                style={{ marginBottom: 10 }}
                disabled={trabajando}
                onClick={() => void elegirEnElEquipo()}
              >
                {trabajando ? 'Abriendo el explorador de Windows…' : 'Elegir carpeta con el explorador de Windows'}
              </button>
            )}

            {carpeta && (
              <>
                <p className="commit">{carpeta.path}</p>

                <div className="acciones" style={{ marginBottom: 8 }}>
                  <button
                    className="boton pequeno"
                    disabled={!carpeta.parent || trabajando}
                    onClick={() => void explorar(carpeta.parent ?? undefined)}
                  >
                    Subir
                  </button>
                  {carpeta.roots.map((raiz) => (
                    <button
                      key={raiz}
                      className="boton pequeno"
                      disabled={trabajando}
                      onClick={() => void explorar(raiz)}
                    >
                      {raiz}
                    </button>
                  ))}
                </div>

                <button
                  className="boton principal"
                  disabled={trabajando}
                  onClick={() => void abrir(carpeta.path)}
                  title="Trabajar sobre esta carpeta"
                >
                  Abrir esta carpeta
                </button>

                {!carpeta.is_git_repo && (
                  // Se puede abrir igual. Solo conviene saber que al hacerlo la carpeta
                  // pasa a ser un repositorio, porque el sistema trabaja con ramas.
                  <p className="nota" style={{ marginTop: 6 }}>
                    Todavía no es un repositorio de Git. Al abrirla se crea uno con lo que
                    haya dentro, que es lo que necesitan los agentes para trabajar cada
                    tarea en su propia rama.
                  </p>
                )}

                <ul className="lista-carpetas" style={{ marginTop: 10 }}>
                  {carpeta.entries.length === 0 && <li className="vacio">No hay ninguna carpeta dentro.</li>}
                  {carpeta.entries.map((e) => (
                    <li key={e.path}>
                      <button
                        className="carpeta"
                        disabled={trabajando}
                        onClick={() => void explorar(e.path)}
                        title={`${e.path}
Pulsa para entrar.`}
                      >
                        <span className="nombre">{e.name}</span>
                        {e.is_git_repo && <span className="etiqueta">repositorio</span>}
                      </button>

                      {/*
                        Una carpeta que es un repositorio se abre desde aquí, sin entrar
                        primero. Entrar y luego subir a buscar el botón de arriba era el
                        camino largo para lo que más se hace.
                      */}
                      <button
                        className="boton pequeno principal abrir-fila"
                        disabled={trabajando}
                        onClick={() => void abrir(e.path)}
                        title={
                          e.is_git_repo
                            ? `Trabajar sobre ${e.path}`
                            : `Trabajar sobre ${e.path}. Al abrirla se crea el repositorio de Git.`
                        }
                      >
                        Abrir
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

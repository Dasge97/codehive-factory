import { useCallback, useEffect, useState } from 'react';
import { api, type CarpetaListada, type ProyectoRegistrado } from '../api';

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

  /** Abre el diálogo de carpetas del sistema, que sale en el equipo donde corre el servicio. */
  async function elegirEnElEquipo() {
    setTrabajando(true);
    setAviso('Elige la carpeta en la ventana que se ha abierto en el equipo donde corre el sistema.');
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

  async function abrir(ruta: string) {
    setTrabajando(true);
    setAviso(null);
    try {
      alAbrir(await api.abrirCarpeta(ruta));
    } catch (e) {
      setAviso(e instanceof Error ? e.message : String(e));
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <div className="detalle-fondo" onClick={alCerrar}>
      <aside className="detalle" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Abrir carpeta">
        <header>
          <h2>Abrir carpeta</h2>
          <button className="boton pequeno" onClick={alCerrar}>Cerrar</button>
        </header>

        <div className="contenido">
          {aviso && <div className="aviso desconectado">{aviso}</div>}

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
                Elegir carpeta con el explorador de Windows
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
                  className="boton"
                  disabled={!carpeta.is_git_repo || trabajando}
                  onClick={() => void abrir(carpeta.path)}
                  title={
                    carpeta.is_git_repo
                      ? 'Trabajar sobre esta carpeta'
                      : 'Solo se pueden abrir carpetas que sean un repositorio de Git'
                  }
                >
                  {carpeta.is_git_repo
                    ? 'Abrir esta carpeta'
                    : 'Esta carpeta no es un repositorio de Git'}
                </button>

                <ul className="lista-carpetas" style={{ marginTop: 10 }}>
                  {carpeta.entries.length === 0 && <li className="vacio">No hay ninguna carpeta dentro.</li>}
                  {carpeta.entries.map((e) => (
                    <li key={e.path}>
                      <button
                        className="carpeta"
                        disabled={trabajando}
                        onClick={() => void explorar(e.path)}
                        title={e.path}
                      >
                        <span className="nombre">{e.name}</span>
                        {e.is_git_repo && <span className="etiqueta">repositorio</span>}
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

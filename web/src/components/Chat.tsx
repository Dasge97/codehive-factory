import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../api';
import { hora } from './Estado';
import { PASOS } from './Recorrido';

interface Props {
  mensajes: ChatMessage[];
  alEnviar: (texto: string) => Promise<void>;
  /** El borrador vive fuera para que no se pierda al cambiar de vista. */
  borrador: string;
  alCambiarBorrador: (texto: string) => void;
  /** Nombre y carpeta del proyecto, para que se vea sobre qué se va a trabajar. */
  proyecto: { name: string; repo_path: string; main_branch: string };
  /** El orquestador tiene un turno en marcha. */
  pensando?: boolean;
  /** Última cosa que se le ha visto hacer, para que la espera no sea un texto fijo. */
  ultimoPaso?: string | null;
  /** Para el turno del orquestador. */
  alParar?: () => void;
  /** La parada ya se ha pedido y se espera la confirmación del motor. */
  paradaPedida?: boolean;
}

export function Chat({
  mensajes,
  alEnviar,
  borrador,
  alCambiarBorrador,
  proyecto,
  pensando = false,
  ultimoPaso = null,
  alParar,
  paradaPedida = false,
}: Props) {
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const final = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Bajar al último mensaje es una comodidad, no algo que deba poder romper el chat:
    // si el navegador no lo admite, el resto sigue funcionando igual.
    try {
      final.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
    } catch {
      // Sin desplazamiento automático.
    }
  }, [mensajes.length, pensando]);

  async function enviar(evento: React.FormEvent) {
    evento.preventDefault();
    const texto = borrador.trim();
    if (!texto || enviando) return;

    setEnviando(true);
    setError(null);
    try {
      await alEnviar(texto);
      alCambiarBorrador('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="panel chat">
      <header>
        <h2>Pídele algo al equipo</h2>
        <span className="contador">{mensajes.length} mensajes</span>
      </header>

      <div className="mensajes">
        {mensajes.length === 0 && <Bienvenida proyecto={proyecto} />}

        {mensajes.map((mensaje) => (
          <div
            key={mensaje.id}
            className={`mensaje ${mensaje.author === 'creator' ? 'del-creador' : 'del-orquestador'}`}
          >
            <span className="autor">
              {mensaje.author === 'creator' ? 'Tú' : 'Orquestador'} · {hora(mensaje.created_at)}
            </span>
            {mensaje.body}
          </div>
        ))}

        {pensando && (
          <div className="mensaje del-orquestador pensando">
            <span className="autor">Orquestador</span>
            <span className="linea-pensando">
              <span className="girando" aria-hidden="true" />
              <span>
                {paradaPedida
                  ? 'Parada pedida. Espero a que el motor confirme.'
                  : (ultimoPaso ?? 'Está leyendo el proyecto y preparando el reparto del trabajo.')}
              </span>
            </span>

            {alParar && !paradaPedida && (
              <button className="boton pequeno peligro" style={{ marginTop: 8 }} onClick={alParar}>
                Parar
              </button>
            )}
          </div>
        )}

        <div ref={final} />
      </div>

      {error && <p className="aviso" style={{ margin: '0 12px 8px' }}>{error}</p>}

      <form onSubmit={enviar}>
        <textarea
          value={borrador}
          onChange={(e) => alCambiarBorrador(e.target.value)}
          onKeyDown={(e) => {
            // Enter envía; con Mayúsculas hace un salto de línea.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void enviar(e);
            }
          }}
          placeholder={`Qué quieres que hagan en ${proyecto.name}`}
          rows={2}
          aria-label="Mensaje para el orquestador"
        />
        <button className="boton principal" type="submit" disabled={enviando || !borrador.trim()}>
          {enviando ? 'Enviando' : 'Enviar'}
        </button>
      </form>
    </section>
  );
}

/**
 * Lo que se ve antes del primer mensaje.
 *
 * Dice tres cosas que no se deducen mirando una pantalla vacía: sobre qué carpeta se va a
 * trabajar, qué recorrido sigue lo que pidas, y qué decisiones siguen siendo tuyas.
 */
function Bienvenida({ proyecto }: { proyecto: Props['proyecto'] }) {
  return (
    <div className="bienvenida">
      <p>
        Escribe qué quieres conseguir. El orquestador lo reparte entre el equipo, y el
        trabajo se hace en <strong>{proyecto.name}</strong>:
      </p>

      <p className="ruta-destacada">{proyecto.repo_path}</p>

      <h3>Qué pasa cuando lo pidas</h3>
      <ol>
        {PASOS.map((paso) => (
          <li key={paso.id}>
            <strong>{paso.titulo}.</strong> {paso.explicacion}
          </li>
        ))}
      </ol>

      <h3>Qué no pasa sin ti</h3>
      <ul>
        <li>Nada llega a la rama {proyecto.main_branch} sin que tú lo confirmes.</li>
        <li>Cada tarea trabaja en una rama aparte, así que tu código no se toca por el camino.</li>
        <li>Ningún agente sube nada a un remoto ni despliega.</li>
      </ul>

      <h3>Ejemplos de lo que puedes pedir</h3>
      <ul>
        <li>«Añade un área de proyectos con su listado y su formulario de alta.»</li>
        <li>«Revisa cómo se validan los nombres y arregla lo que esté mal.»</li>
        <li>«Explícame cómo funciona la cola de tareas antes de tocar nada.»</li>
      </ul>
    </div>
  );
}

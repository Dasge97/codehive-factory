import { useEffect, useRef, useState } from 'react';
import type { AgentView, ChatMessage, ConversationView } from '../api';
import { hora } from './Estado';
import { Texto } from './Texto';

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
  /**
   * El orquestador, para que su caja se vea igual que la de los demás agentes.
   *
   * El chat es el panel del orquestador: ocupa lo mismo que el resto y lleva su nombre,
   * su motor y su indicador en la cabecera.
   */
  agente?: AgentView | null;
  /** Este panel es el que estás mirando: se ve entero y por delante de los demás. */
  enfocado?: boolean;
  /** Pulsar en cualquier sitio del panel lo pone en primer plano. */
  alEnfocar?: () => void;
  /** Las conversaciones que ha habido en esta carpeta, de la más reciente a la más vieja. */
  conversaciones?: ConversationView[];
  alEmpezarConversacion?: () => void;
  alAbrirConversacion?: (conversationId: string) => void;
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
  agente = null,
  enfocado = false,
  alEnfocar,
  conversaciones = [],
  alEmpezarConversacion,
  alAbrirConversacion,
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
    <section
      className={`agente-panel chat${pensando ? ' activo' : ''}${enfocado ? ' enfocado' : ''}`}
      data-rol="orquestador"
      // Escribir en la caja también trae este panel al frente.
      onMouseDown={alEnfocar}
      onFocusCapture={alEnfocar}
    >
      <header>
        {agente ? (
          <>
            <span className={`indicador${pensando ? ' latiendo' : ''}`} aria-hidden="true" />
            <div className="quien">
              <strong>{agente.name}</strong>
              <span className="rol">Orquestación · {agente.engine}</span>
            </div>
          </>
        ) : (
          <h2>Pídele algo al equipo</h2>
        )}

        {/*
          Las conversaciones van fuera de la parte que depende del agente: poder volver a
          una anterior no tiene nada que ver con que el proyecto tenga registrado su
          orquestador.
        */}
        <Conversaciones
          conversaciones={conversaciones}
          alEmpezar={alEmpezarConversacion}
          alAbrir={alAbrirConversacion}
        />

        {agente ? (
          <span className={`situacion${pensando ? ' trabajando' : ''}`}>
            {pensando ? 'pensando' : 'te escucha'}
          </span>
        ) : (
          <span className="contador">{mensajes.length} mensajes</span>
        )}
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
            <Texto>{mensaje.body}</Texto>
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
 * Volver a una conversación anterior de esta carpeta, o empezar una en blanco.
 *
 * El orquestador solo ve la conversación abierta. Empezar una nueva no borra nada: la
 * anterior sigue en la lista y se puede volver a ella. Las tareas y el trabajo del
 * proyecto no dependen de la conversación, así que no se tocan.
 */
function Conversaciones({
  conversaciones,
  alEmpezar,
  alAbrir,
}: {
  conversaciones: ConversationView[];
  alEmpezar?: () => void;
  alAbrir?: (conversationId: string) => void;
}) {
  if (!alEmpezar && !alAbrir) return null;

  const actual = conversaciones.find((c) => c.is_current);

  return (
    <div className="conversaciones" onMouseDown={(e) => e.stopPropagation()}>
      {alAbrir && conversaciones.length > 1 && (
        <select
          value={actual?.id ?? ''}
          onChange={(e) => alAbrir(e.target.value)}
          aria-label="Conversación"
          title="Volver a una conversación anterior de esta carpeta"
        >
          {conversaciones.map((c) => (
            <option key={c.id} value={c.id}>
              {(c.title ?? 'Sin empezar') + ` · ${c.messages} mensajes`}
            </option>
          ))}
        </select>
      )}

      {alEmpezar && (
        <button
          className="boton pequeno"
          onClick={alEmpezar}
          title="Empezar una conversación en blanco. La de ahora se guarda y puedes volver a ella."
        >
          Nueva
        </button>
      )}
    </div>
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
        <li>
          <strong>Se reparte.</strong> El orquestador convierte lo que pides en tareas concretas.
        </li>
        <li>
          <strong>Se construye.</strong> Un agente escribe el código en una rama aparte y publica un commit.
        </li>
        <li>
          <strong>Se revisa.</strong> Otro agente revisa ese commit. Si encuentra un fallo, abre una corrección.
        </li>
        <li>
          <strong>Tú integras.</strong> Nada llega a la rama principal sin que tú lo confirmes.
        </li>
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

import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../api';
import { hora } from './Estado';

interface Props {
  mensajes: ChatMessage[];
  alEnviar: (texto: string) => Promise<void>;
  /** El borrador vive fuera para que no se pierda al cambiar de vista en el móvil. */
  borrador: string;
  alCambiarBorrador: (texto: string) => void;
}

export function Chat({ mensajes, alEnviar, borrador, alCambiarBorrador }: Props) {
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const final = useRef<HTMLDivElement>(null);

  useEffect(() => {
    final.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [mensajes.length]);

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
    <section className="panel chat" style={{ flex: 1, minHeight: 0 }}>
      <header>
        <h2>Orquestador</h2>
        <span className="contador">{mensajes.length} mensajes</span>
      </header>

      <div className="mensajes">
        {mensajes.length === 0 && (
          <p className="vacio">
            Cuéntale al orquestador qué quieres conseguir. Él reparte el trabajo entre el equipo.
          </p>
        )}

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
          placeholder="Escribe qué quieres conseguir"
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

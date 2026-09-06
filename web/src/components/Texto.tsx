import { Fragment, type ReactNode } from 'react';

/**
 * Pinta el texto que escriben los agentes.
 *
 * Los modelos escriben con las marcas de siempre: dobles asteriscos para resaltar y
 * comillas invertidas para el código. Sin esto, el creador ve los asteriscos en crudo.
 *
 * Se reconocen solo esas dos marcas y las listas. No es un lector de Markdown completo a
 * propósito: un mensaje de chat no necesita tablas ni enlaces, y traer una librería entera
 * para dos marcas no compensa.
 */
export function Texto({ children }: { children: string }) {
  const lineas = children.split('\n');
  const bloques: ReactNode[] = [];
  let lista: string[] = [];

  const cerrarLista = (clave: string) => {
    if (lista.length === 0) return;
    bloques.push(
      <ul key={clave}>
        {lista.map((punto, i) => (
          <li key={i}>
            <Inline texto={punto} />
          </li>
        ))}
      </ul>,
    );
    lista = [];
  };

  lineas.forEach((linea, indice) => {
    const punto = /^\s*[-*•]\s+(.*)$/.exec(linea);
    const numerado = /^\s*\d+[.)]\s+(.*)$/.exec(linea);

    if (punto || numerado) {
      lista.push((punto ?? numerado)![1]!);
      return;
    }

    cerrarLista(`lista-${indice}`);

    if (linea.trim() === '') {
      bloques.push(<span key={`salto-${indice}`} className="salto" />);
      return;
    }

    bloques.push(
      <p key={`parrafo-${indice}`}>
        <Inline texto={linea} />
      </p>,
    );
  });

  cerrarLista('lista-final');
  return <div className="texto-formateado">{bloques}</div>;
}

/** Resalta y código dentro de una línea. */
function Inline({ texto }: { texto: string }) {
  // Se parte por los dos tipos de marca a la vez, conservando los separadores.
  const trozos = texto.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);

  return (
    <>
      {trozos.map((trozo, i) => {
        if (trozo.startsWith('**') && trozo.endsWith('**') && trozo.length > 4) {
          return <strong key={i}>{trozo.slice(2, -2)}</strong>;
        }
        if (trozo.startsWith('`') && trozo.endsWith('`') && trozo.length > 2) {
          return <code key={i}>{trozo.slice(1, -1)}</code>;
        }
        return <Fragment key={i}>{trozo}</Fragment>;
      })}
    </>
  );
}

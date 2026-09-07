/**
 * Ficheros que ningún agente puede modificar.
 *
 * La lista la declara el proyecto en `codehive.project.json`. Decírselo al agente en su
 * encargo es una petición, y una petición se puede desatender. Por eso el worker comprueba
 * además los ficheros que ha tocado el commit: si alguno está protegido, el trabajo no se
 * publica y la tarea queda bloqueada.
 */

/** Caracteres con significado en una expresión regular, salvo los comodines del patrón. */
function escapar(texto: string): string {
  return texto.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convierte un patrón de ruta en una expresión regular.
 *
 * `**` cubre cualquier número de carpetas. `*` y `?` se quedan dentro de un tramo, así que
 * `src/*.ts` no alcanza a `src/core/db.ts`.
 */
export function patronARegExp(patron: string): RegExp {
  const normalizado = patron.replace(/\\/g, '/').replace(/^\.\//, '');

  let cuerpo = '';
  for (let i = 0; i < normalizado.length; i++) {
    const c = normalizado[i]!;

    if (c === '*' && normalizado[i + 1] === '*') {
      // `**/` cubre también el caso de cero carpetas, para que `**/x` alcance a `x`.
      if (normalizado[i + 2] === '/') {
        cuerpo += '(?:.*/)?';
        i += 2;
      } else {
        cuerpo += '.*';
        i += 1;
      }
      continue;
    }

    if (c === '*') {
      cuerpo += '[^/]*';
    } else if (c === '?') {
      cuerpo += '[^/]';
    } else {
      cuerpo += escapar(c);
    }
  }

  // Un patrón sin comodines nombra un fichero o una carpeta entera. Sin esta parte,
  // proteger `.github` no protegería `.github/workflows/publica.yml`.
  const sinComodines = !/[*?]/.test(normalizado);
  return new RegExp(`^${cuerpo}${sinComodines ? '(?:/.*)?' : ''}$`);
}

/** Verdadero si una ruta cae dentro de alguno de los patrones. */
export function rutaProtegida(ruta: string, patrones: string[]): string | null {
  const normalizada = ruta.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const patron of patrones) {
    if (patronARegExp(patron).test(normalizada)) return patron;
  }
  return null;
}

export interface FicheroProtegido {
  file: string;
  pattern: string;
}

/** Ficheros de un cambio que tocan rutas protegidas, con el patrón que los cubre. */
export function ficherosProtegidos(ficheros: string[], patrones: string[]): FicheroProtegido[] {
  if (patrones.length === 0) return [];

  const encontrados: FicheroProtegido[] = [];
  for (const file of ficheros) {
    const pattern = rutaProtegida(file, patrones);
    if (pattern) encontrados.push({ file, pattern });
  }
  return encontrados;
}

/** El motivo que se guarda y se le enseña a la persona cuando un cambio toca lo protegido. */
export function motivoDeBloqueo(protegidos: FicheroProtegido[]): string {
  const lista = protegidos.map((p) => `${p.file} (protegido por ${p.pattern})`).join(', ');
  return `El cambio toca ficheros protegidos del proyecto: ${lista}. El trabajo no se ha publicado.`;
}

/**
 * Convierte el uso de una herramienta en una frase corta y legible.
 *
 * Los motores publican los argumentos de cada herramienta como un objeto entero. Volcarlo
 * tal cual llena el panel del agente de JSON que nadie lee. Aquí se saca solo el dato que
 * dice qué está haciendo: el fichero que toca, el comando que ejecuta, lo que busca.
 */
export function describirUsoDeHerramienta(herramienta: string, argumentos: unknown): string {
  return recortar(describir(herramienta, argumentos), 140);
}

function describir(herramienta: string, argumentos: unknown): string {
  const args = (argumentos ?? {}) as Record<string, unknown>;
  const texto = (clave: string): string | null => {
    const valor = args[clave];
    return typeof valor === 'string' && valor.trim() ? valor.trim() : null;
  };

  const fichero = texto('file_path') ?? texto('path') ?? texto('notebook_path');
  const patron = texto('pattern');

  switch (herramienta) {
    case 'Read':
      return fichero ? `lee ${nombreCorto(fichero)}` : 'lee un fichero';

    case 'Write':
      return fichero ? `escribe ${nombreCorto(fichero)}` : 'escribe un fichero';

    case 'Edit':
    case 'NotebookEdit':
      return fichero ? `edita ${nombreCorto(fichero)}` : 'edita un fichero';

    case 'Bash':
    case 'PowerShell':
      return recortar(texto('command') ?? 'ejecuta una orden', 100);

    case 'Glob':
      return patron ? `busca ficheros ${patron}` : 'busca ficheros';

    case 'Grep':
      return patron ? `busca ${recortar(patron, 50)}` : 'busca en el código';

    case 'WebFetch':
      return `consulta ${texto('url') ?? 'una página'}`;

    case 'WebSearch':
      return `busca en internet ${recortar(texto('query') ?? '', 60)}`.trim();

    case 'TodoWrite':
      return 'actualiza su lista de pasos';

    // Con esta herramienta el agente entrega su resultado final. Su contenido es el
    // resumen entero, que ya se ve en la tarea: en el panel solo interesa saber que ya
    // ha terminado.
    case 'StructuredOutput':
    case 'structured_output':
      return 'entrega su resultado';

    default: {
      // Herramienta que no conocemos: se enseña el primer texto corto que traiga.
      const primero = Object.values(args).find(
        (v) => typeof v === 'string' && v.trim().length > 0 && v.length < 120,
      );
      return typeof primero === 'string' ? `${herramienta}: ${primero.trim()}` : `usa ${herramienta}`;
    }
  }
}

/** Deja el nombre del fichero con su carpeta, sin la ruta entera del disco. */
export function nombreCorto(ruta: string): string {
  const partes = ruta.replace(/\\/g, '/').split('/').filter(Boolean);
  return partes.slice(-2).join('/') || ruta;
}

/** Recorta un texto a lo que cabe, sin cortar a mitad de una palabra si se puede evitar. */
export function recortar(texto: string, maximo: number): string {
  const limpio = texto.replace(/\s+/g, ' ').trim();
  if (limpio.length <= maximo) return limpio;

  const corte = limpio.lastIndexOf(' ', maximo);
  return `${limpio.slice(0, corte > maximo * 0.6 ? corte : maximo)}…`;
}

/**
 * Resume el resultado de una herramienta.
 *
 * Un resultado suele ser el contenido entero de un fichero o la salida de un comando. En
 * el panel solo interesa saber si fue bien y cuánto devolvió.
 */
export function describirResultado(contenido: string, huboError: boolean): string {
  const util = sinRuidoDelShell(contenido);
  const limpio = util.replace(/\s+/g, ' ').trim();
  if (!limpio) return huboError ? 'falla sin decir por qué' : 'sin salida';

  if (huboError) return recortar(limpio, 140);

  const lineas = util.split('\n').length;
  return lineas > 3 ? `${recortar(limpio, 80)} (${lineas} líneas)` : recortar(limpio, 120);
}

/**
 * Quita los avisos que el shell escribe al arrancar, antes de ejecutar nada.
 *
 * Un shell mal configurado los repite en la salida de **cada** comando. Sin quitarlos, el
 * panel del agente se llena de la misma línea una y otra vez y no se ve lo que de verdad
 * hizo el comando. Un ejemplo real es un `.profile` que resulta ser una carpeta.
 *
 * Solo se quitan al principio de la salida, que es donde el shell los escribe. Una línea
 * igual en medio de la salida es del comando y se conserva.
 */
const RUIDO_DE_ARRANQUE =
  /^(?:[^\n:]*(?:bash|sh|zsh)(?:\.exe)?:\s.*(?:is a directory|No such file or directory|Permission denied|cannot execute)\s*)$/i;

export function sinRuidoDelShell(salida: string): string {
  const lineas = salida.split('\n');
  let desde = 0;
  while (desde < lineas.length) {
    const linea = (lineas[desde] ?? '').trim();
    if (linea === '' || RUIDO_DE_ARRANQUE.test(linea)) desde += 1;
    else break;
  }

  // Si todo era ruido, la salida original manda: es mejor enseñar algo que nada.
  return desde >= lineas.length ? salida : lineas.slice(desde).join('\n');
}

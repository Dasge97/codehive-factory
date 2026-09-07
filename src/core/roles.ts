import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { AGENT_ROLES, type AgentRole, type EngineName } from '../shared/types.js';

/**
 * Instrucciones de cada agente.
 *
 * El texto vive en ficheros dentro de `instrucciones/`, no en este código. Cambiar lo que
 * hace un agente es editar un fichero de texto, no recompilar el sistema. Los agentes las
 * reciben en cada ejecución, así que un cambio en un fichero se aplica a la siguiente
 * tarea sin reiniciar nada.
 *
 * Se compone en dos partes:
 *
 * - `instrucciones/comunes/`: las reglas que valen para todos los agentes. Se leen todas,
 *   por orden de nombre de fichero.
 * - `instrucciones/roles/<rol>.md`: lo que hace ese rol en concreto.
 */

/** Carpeta `instrucciones/`, resuelta desde este módulo y no desde el directorio actual. */
const RAIZ_INSTRUCCIONES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'instrucciones',
);

export interface RoleDefaults {
  name: string;
  tools: string[];
}

/**
 * Nombre y herramientas de cada rol.
 *
 * Las herramientas no son texto para el agente sino permisos que se le dan al motor, así
 * que viven en el código y no en un fichero editable.
 */
export const ROLE_DEFAULTS: Record<AgentRole, RoleDefaults> = {
  orchestrator: {
    name: 'Orquestador',
    // Solo lectura: separa quién decide de quién ejecuta (decisión D16).
    tools: ['Read', 'Glob', 'Grep'],
  },

  builder: {
    name: 'Builder',
    // TodoWrite es la lista de pasos que el motor lleva por dentro. Sin ella, un trabajo
    // de muchos pasos se le olvida a la mitad.
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite'],
  },

  reviewer: {
    name: 'Reviewer',
    // Sin escritura: el reviewer no corrige el código que revisa.
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
  },

  researcher: {
    name: 'Investigador',
    // Es el único rol que puede salir a internet. Una pregunta sobre una biblioteca de
    // terceros no se responde leyendo el repositorio.
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
  },

  refactorer: {
    name: 'Refactorer',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite'],
  },
};

/** Lee un fichero de instrucciones y falla con un mensaje que dice cuál falta. */
function leer(ruta: string): string {
  try {
    return readFileSync(ruta, 'utf8').trim();
  } catch {
    throw new Error(`No se encuentra el fichero de instrucciones ${ruta}.`);
  }
}

/** Las reglas comunes, en orden de nombre de fichero. */
export function reglasComunes(): string {
  const carpeta = join(RAIZ_INSTRUCCIONES, 'comunes');
  let ficheros: string[];
  try {
    ficheros = readdirSync(carpeta).filter((f) => f.endsWith('.md')).sort();
  } catch {
    throw new Error(`No se encuentra la carpeta de instrucciones comunes ${carpeta}.`);
  }

  return ficheros.map((f) => leer(join(carpeta, f))).join('\n\n');
}

/**
 * Las instrucciones completas de un rol: lo suyo primero y las reglas comunes después.
 *
 * Se leen del disco en cada llamada. El coste es despreciable comparado con una ejecución
 * de un motor, y a cambio se puede corregir una instrucción con el sistema en marcha.
 */
export function instructionsFor(role: AgentRole): string {
  const propias = leer(join(RAIZ_INSTRUCCIONES, 'roles', `${role}.md`));
  return `${propias}\n\n${reglasComunes()}`;
}

/**
 * Comprueba que existen las instrucciones de todos los roles.
 *
 * Se llama al arrancar, para que un fichero que falta se note al levantar el sistema y no
 * a mitad de una tarea.
 */
export function comprobarInstrucciones(): void {
  for (const role of AGENT_ROLES) instructionsFor(role);
}

/**
 * Motor con el que se ejecuta cada rol por omisión.
 *
 * La revisión va con un motor distinto del que construye: dos proveedores distintos
 * revisando el trabajo del otro detectan más fallos que uno revisándose a sí mismo, y
 * reparte el consumo entre las dos suscripciones (decisión D34).
 *
 * Si el motor preferido no está instalado, el rol cae a Claude Code.
 */
export const ENGINE_POR_ROL: Record<AgentRole, EngineName> = {
  orchestrator: 'claude_code',
  builder: 'claude_code',
  reviewer: 'codex',
  researcher: 'claude_code',
  // El refactorer mira el mismo código que acaba de escribir el builder. Con otro motor,
  // lo mira alguien que no lo ha escrito.
  refactorer: 'codex',
};

/**
 * Modelo con el que se ejecuta cada rol en Claude Code.
 *
 * Se escribe aquí a propósito. Sin un modelo explícito, el motor coge el que tenga
 * configurado en sus ajustes la persona que arranca el sistema, y el mismo proyecto se
 * comporta distinto según en qué equipo se levante.
 *
 * Se usan alias y no identificadores completos: un alias apunta siempre al último modelo
 * de esa familia, mientras que un identificador escrito a mano queda desfasado sin avisar.
 */
export const MODELO_POR_ROL: Record<AgentRole, string> = {
  orchestrator: 'opus',
  builder: 'opus',
  reviewer: 'opus',
  // Buscar y leer no necesita el modelo más caro.
  researcher: 'sonnet',
  refactorer: 'sonnet',
};

/**
 * Modelo con el que arranca un agente, según su rol y su motor.
 *
 * Con Codex no se fija ninguno. Sus modelos los nombra su propio ejecutable, y una lista
 * escrita aquí dejaría de valer en cuanto Codex cambiara los suyos.
 */
export function modeloPara(role: AgentRole, engine: EngineName): string | null {
  return engine === 'claude_code' ? MODELO_POR_ROL[role] : null;
}

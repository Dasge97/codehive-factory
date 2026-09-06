# 11 · Capacidades del adaptador de Claude Code

Resultado de la fase 0 del plan de implementación. Comprobado el 6 de septiembre de 2026
con Claude Code 2.1.261, Node 22.19.0, Git 2.51.0 y Windows 11.

Las pruebas se hicieron con el modelo Sonnet para no gastar cuota de Opus. El motor de
producción se configura por agente.

## 11.1 Resultado de cada comprobación

| ID | Comprobación | Resultado |
| --- | --- | --- |
| F0-01 | Repositorio local conectado al remoto público. | Correcto. |
| F0-02 | Ejecución programática con salida estructurada. | Correcto. |
| F0-03 | Continuidad de una sesión entre ejecuciones. | Correcto. |
| F0-04 | Restricción de herramientas y denegación de permisos. | Correcto. |
| F0-05 | Parada de una ejecución en curso. | Correcto. |
| F0-06 | Fallo de autenticación detectable. | Correcto. Falta de cuota comprobada solo de forma parcial. |
| F0-07 | Dos ejecuciones simultáneas en worktrees distintos. | Correcto. |

## 11.2 Cómo se invoca el motor

Forma que usa el adaptador:

```
claude.exe -p
  --model <modelo>
  --output-format stream-json --verbose
  --tools "<lista de herramientas>"
  --strict-mcp-config
  --permission-mode <modo>
  --permission-prompts none
  --json-schema '<esquema del resultado>'
  --session-id <uuid>        (primera ejecución)
  --resume <uuid>            (ejecuciones siguientes)
```

El prompt se escribe en la entrada estándar del proceso y se cierra la entrada. El
directorio de trabajo del proceso es el worktree de la tarea.

## 11.3 Cinco cosas que hay que hacer bien en Windows

Cada una costó una prueba fallida. Son requisitos del adaptador, no recomendaciones.

**Usar el ejecutable nativo, no el guion de arranque.** El ejecutable está en
`~/.local/bin/claude.exe`. Lanzar `claude.cmd` sin shell da un error `EINVAL` en Node 22.
El adaptador resuelve la ruta del `.exe` al arrancar y falla claramente si no la
encuentra.

**No usar `shell: true` en `spawn`.** Con shell activado, un prompt largo con comillas
llega cortado al motor y el agente responde a un encargo incompleto. El fallo es
silencioso: la ejecución termina bien y produce un resultado equivocado.

**Pasar el prompt por la entrada estándar, no como argumento.** Evita el problema de las
comillas y no tiene límite de longitud de línea de órdenes.

**Cerrar la entrada estándar siempre.** Si no se cierra, el motor espera tres segundos y
avisa por la salida de error antes de continuar.

**Añadir `--strict-mcp-config`.** Sin esa opción, los servidores MCP configurados en el
equipo del creador siguen disponibles para el agente aunque se restrinjan las
herramientas con `--tools`.

## 11.4 Eventos que publica el motor

Con `--output-format stream-json --verbose`, cada línea de la salida es un objeto JSON.

| Tipo | Contenido útil |
| --- | --- |
| `system` con subtipo `init` | `session_id`, `tools`, `model`, `permissionMode`, `capabilities`, versión. |
| `rate_limit_event` | Consumo de la suscripción. Ver el apartado 11.6. |
| `assistant` | Mensajes y llamadas a herramientas del agente. |
| `user` | Resultados de las herramientas, incluidos los errores de permiso. |
| `result` | Resumen final de la ejecución. Ver el apartado 11.5. |

## 11.5 El evento final de resultado

Campos que usa el sistema:

| Campo | Uso |
| --- | --- |
| `session_id` | Se guarda en `runs.engine_session_id` para continuar la sesión. |
| `result` | El resultado del agente. Con `--json-schema`, es una cadena con JSON validado. |
| `total_cost_usd` | Coste de la ejecución. |
| `usage` | Tokens de entrada, de salida, de creación de caché y de lectura de caché. |
| `duration_api_ms` | Tiempo de llamada al modelo. |
| `permission_denials` | Lista de herramientas denegadas, con sus argumentos exactos. |
| `terminal_reason` | Motivo del final. `api_error` indica fallo de autenticación o de la API. |
| `is_error` | Si la ejecución terminó en error. |

**Si no llega el evento de resultado, la ejecución no terminó.** Al matar el proceso, la
salida se corta sin publicarlo. El worker trata la ausencia del evento como ejecución
interrumpida o cancelada.

## 11.6 Consumo de la suscripción

El evento `rate_limit_event` publica el estado real de los límites de la cuenta:

```json
{
  "status": "allowed",
  "rateLimitType": "five_hour",
  "resetsAt": 1788702600,
  "overageStatus": "rejected",
  "isUsingOverage": false,
  "unifiedWindows": {
    "five_hour": { "utilization": 0.03, "resetsAt": 1788702600 },
    "seven_day": { "utilization": 0.04, "resetsAt": 1789171200 }
  }
}
```

El sistema guarda la utilización de las dos ventanas y la muestra en la cabecera del
proyecto. Es el dato que cumple la parte de consumo del apartado 9 del documento de
visión, sin inventar ninguna cifra.

`isUsingOverage` en falso confirma que la ejecución consume la suscripción y no una
modalidad de pago por uso.

## 11.7 Control de herramientas y permisos

`--tools` fija qué herramientas del conjunto interno tiene el agente. Con `--tools ""` no
tiene ninguna. Con `--tools "Read"` puede leer y no puede escribir; la prueba lo confirmó
comprobando que el fichero pedido no se creó.

`--permission-mode` acepta `manual`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`
y `plan`.

`--permission-prompts none` significa que nadie puede responder a una petición de
permiso, así que se deniega automáticamente. La denegación aparece en dos sitios: como
resultado de herramienta con error, y en `permission_denials` del evento final, con el
nombre de la herramienta y los argumentos exactos.

**Cómo funcionan las autorizaciones en el sistema.** El worker ejecuta con permisos
suficientes para trabajar dentro de su worktree y con nadie respondiendo prompts. Si el
agente intenta algo no permitido, se deniega, la ejecución continúa y la denegación queda
registrada. El worker convierte cada denegación en una petición de autorización para el
creador. Si el creador la aprueba, la siguiente ejecución de la tarea añade esa
herramienta a las permitidas.

Es un mecanismo asíncrono. Encaja con la decisión D12, que fija el final de una ejecución
como punto seguro. No requiere un servidor MCP de permisos.

## 11.8 Continuidad de sesión

`--session-id` fija el identificador de la primera ejecución. `--resume` con el mismo
identificador continúa la conversación: en la prueba, la segunda ejecución recordó un
dato dado en la primera. El identificador se conserva entre ejecuciones.

## 11.9 Contrato de resultado con esquema

`--json-schema` recibe un esquema JSON y el motor devuelve un resultado que lo cumple. La
prueba devolvió un objeto con los campos `outcome` y `summary` del contrato del documento
05.

Sustituye al fichero `.codehive/result.json` que se había diseñado antes de la fase 0. El
motor valida el formato, así que el worker no depende de que el agente escriba bien un
fichero.

El campo `result` del evento final llega como cadena de texto. El worker la convierte a
objeto y la valida otra vez contra el mismo esquema.

## 11.10 Parada de una ejecución

Enviar la señal de terminación al proceso lo detiene. En la prueba, el proceso murió a
los cuatro segundos, sin dejar procesos huérfanos y sin publicar el evento de resultado.
El worktree queda intacto y se puede inspeccionar.

## 11.11 Falta de cuota y fallo de autenticación

Con una clave de API inválida en modo `--bare`, el motor termina con código de salida 1 y
`terminal_reason` igual a `api_error`, sin coste y sin iteraciones. Es distinguible de un
error normal del trabajo del agente.

**Aviso importante:** el fallo tardó más de dos minutos en producirse, porque el motor
reintenta antes de rendirse. El adaptador necesita un tiempo máximo de ejecución
configurable; sin él, una tarea con problema de autenticación bloquea un worker durante
minutos.

La falta de cuota real no se pudo provocar durante la prueba. El sistema la detectará por
el campo `status` del evento de límites y por `terminal_reason`. Queda pendiente
confirmarlo la primera vez que ocurra en uso real.

## 11.12 Dos ejecuciones simultáneas

Dos procesos lanzados a la vez sobre dos worktrees distintos del mismo repositorio
terminaron en 12 y 13 segundos, solapados en el tiempo, cada uno con su commit en su
rama. No hubo interferencia entre ellos.

## 11.13 Otras opciones útiles del motor

| Opción | Para qué sirve en el sistema |
| --- | --- |
| `--max-budget-usd` | Techo de gasto por ejecución. Refuerza los límites de la decisión D18. |
| `--add-dir` | Da acceso a un directorio adicional cuando una tarea lo necesita. |
| `--append-system-prompt` | Añade las instrucciones del rol sin sustituir el prompt interno del motor. |
| `--fallback-model` | Modelo alternativo cuando el principal no está disponible. |
| `--include-partial-messages` | Progreso más fino en la web, a costa de más eventos. |
| `--no-session-persistence` | Para ejecuciones que no necesitan continuarse. |

## 11.14 Qué cambia en la documentación por culpa de esta fase

1. El contrato de resultado usa `--json-schema` en lugar del fichero `.codehive/result.json`. Afecta al documento 05.
2. Las autorizaciones se resuelven entre ejecuciones, a partir de `permission_denials`. Afecta a los documentos 05 y 07.
3. El consumo mostrado al creador sale del evento de límites de la suscripción. Afecta al documento 08.
4. El adaptador necesita un tiempo máximo de ejecución. Afecta al documento 03.

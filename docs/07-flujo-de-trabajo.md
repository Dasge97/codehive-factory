# 07 · Flujo de trabajo

## 7.1 Estados de una tarea

| Estado | Significado | Pasa a |
| --- | --- | --- |
| `pending` | Creada, pero le falta una dependencia, una respuesta o un recurso. | `ready`, `cancelled` |
| `ready` | Puede ser reclamada por un worker del rol indicado. | `in_progress`, `blocked`, `cancelled` |
| `in_progress` | Tiene una ejecución activa. | `in_review`, `ready`, `blocked`, `done` |
| `in_review` | Publicó un incremento y espera revisión. | `ready`, `done`, `blocked` |
| `blocked` | Necesita una decisión, una dependencia o un recurso identificado. | `ready`, `cancelled` |
| `done` | Cumple sus criterios y no tiene hallazgos bloqueantes abiertos. | terminal |
| `cancelled` | Ha dejado de formar parte del trabajo pedido. | terminal |

Los estados pertenecen a cada tarea. Ninguna transición espera a que el equipo entero
llegue a un punto común: es lo que cumple el requisito A03.

De `in_progress` a `ready` se vuelve cuando una ejecución termina sin completar la tarea
y quedan intentos disponibles. De `in_review` a `ready` se vuelve cuando el reviewer
abre un hallazgo bloqueante.

## 7.2 Del mensaje del creador a la primera tarea

1. El creador escribe en el chat. El mensaje se guarda en `chat_messages`.
2. El supervisor despierta al worker del orquestador.
3. El orquestador recibe el mensaje, el estado del proyecto y las decisiones vigentes.
4. Crea tareas con `crear_tarea`. Cada tarea nace en `pending`.
5. El servicio pasa a `ready` las tareas cuyas dependencias ya están cerradas.
6. El orquestador responde al creador con `responder_creador`.

## 7.3 Ejecución de una tarea

1. El supervisor busca tareas en `ready` cuyo rol tenga un worker libre.
2. El worker reclama la tarea con la transacción descrita en el documento 04. Si la
   transacción afecta a cero filas, vuelve a consultar la cola.
3. El worker prepara el directorio de trabajo (decisión D45). Si la tarea toca código,
   crea el worktree: `git worktree add ../workspaces/<id de tarea> -b task/<id de tarea>
   <rama principal>`. Una revisión usa el worktree de la tarea que revisa. Una
   investigación usa un worktree sin rama que se elimina al terminar.
4. Si el proyecto define `install_command`, el worker lo ejecuta en el worktree nuevo.
5. El worker construye el encargo del documento 05 y lanza el motor.
6. Mientras el motor trabaja, el worker publica eventos `run.progress`.
7. Al terminar, el worker lee el resultado que el motor devuelve con el esquema acordado
   (decisión D21), lo valida y lo guarda.

Si el resultado falta o no valida, la ejecución se marca como fallida con ese motivo y la
tarea vuelve a `ready` si le quedan intentos.

## 7.4 Revisión

1. Una tarea de tipo `build` que termina con `outcome` igual a `completed` y con commit
   pasa a `in_review`, y el servicio crea una tarea de tipo `review` para el reviewer,
   con el identificador del incremento.
2. La tarea de construcción no ocupa worker mientras está en revisión. El builder puede
   tomar otra tarea. Esto es lo que cumple el requisito A02.
3. El reviewer ejecuta la tarea de revisión sobre el commit indicado, en el worktree de la
   tarea revisada. Recibe los hallazgos anteriores que sigan abiertos, para comprobar si
   el incremento nuevo los resuelve.
4. Si devuelve hallazgos, cada uno se guarda. Los de gravedad `blocker` o `major` devuelven
   la tarea revisada a `ready`, con prioridad alta y los hallazgos en su encargo. Los
   `minor` se registran y no detienen nada.
5. Si no hay hallazgos que obliguen a corregir, el incremento queda aprobado y la tarea
   pasa a `done`, a la espera de integración. En modo estricto pasa antes por el refactorer
   (apartado 7.6).

## 7.5 Corrección

La corrección la hace la misma tarea, en su siguiente intento, sobre su misma rama y su
mismo worktree (decisión D44). El encargo lleva cada hallazgo con su condición de
resolución.

La corrección produce un incremento nuevo, que genera una revisión nueva. La aprobación
del incremento anterior no se traslada. Al dar un veredicto nuevo, el reviewer vuelve a
abrir los hallazgos que sigan sin cumplirse; los demás pasan a `fixed`.

**Contra los bucles.** Cada incremento rechazado cuenta. Cuando los incrementos rechazados
de una tarea llegan a `max_task_attempts`, la tarea pasa a `blocked` con los últimos
hallazgos y el orquestador toma un turno. El orquestador decide si reformula la tarea, la
reabre con una nota, o la lleva al creador.

**Contra el hambre de tareas antiguas.** La prioridad efectiva de una tarea baja un punto
por cada hora que lleva en estado `ready`. Una tarea antigua acaba adelantando a
correcciones menores recién creadas. El ajuste se calcula en la consulta de la cola, no
se guarda.

## 7.6 Limpieza en modo estricto

Cuando el reviewer aprueba un incremento en modo estricto, el servicio crea una tarea de
tipo `refactor` sobre el mismo worktree y la misma rama, y la tarea aprobada sigue en
`in_review` esperando. El refactor publica su incremento, que se revisa como cualquier
otro. Cuando queda aprobado, las dos tareas pasan a `done` y el commit del refactor es el
commit final de la tarea original. Si el refactor se bloquea o se cancela, la rama vuelve
al commit aprobado y la tarea original queda hecha con él.

## 7.7 Trabajo simultáneo sobre el mismo proyecto

Cada tarea que toca código tiene su worktree y su rama. Dos builders pueden trabajar a la
vez si sus patrones de ruta reservados no se solapan.

Si el orquestador crea dos tareas que reservan el mismo patrón, la segunda no es
reclamable hasta que la primera libera su bloqueo. La web muestra la espera con el motivo.

Cuando dos tareas necesitan cambiar la misma interfaz, la salida correcta es una sola
tarea que acuerde el contrato y dos tareas dependientes que lo usen.

## 7.8 Integración

La integración la confirma el creador (decisión D04).

1. La web muestra la tarea como lista para integrar cuando está en `done`, tiene commit y
   no tiene hallazgos bloqueantes abiertos. Una revisión o un refactor no se ofrecen nunca.
2. El creador pulsa integrar.
3. El servicio comprueba que el repositorio del creador está en la rama principal, sin
   cambios sin confirmar, y que la punta de la rama de la tarea es el commit aprobado. Si
   algo falla, lo dice y no toca nada (decisión D45).
4. Intenta fusionar la rama de la tarea y ejecuta `verify_command`.
5. Si la fusión da conflicto, la tarea vuelve a `ready` con el motivo y el builder
   resuelve el conflicto en su worktree.
6. Si las verificaciones fallan tras fusionar, la fusión se deshace y se abre un hallazgo
   de gravedad `blocker` sobre la tarea, que vuelve a `ready` para corregirlo.
7. Si todo pasa, se publica `integration.completed`, se libera el bloqueo de recursos y
   se elimina el worktree.

Una revisión aprobada sobre una rama aislada no garantiza que la integración funcione.
El paso 6 existe por eso.

## 7.9 Cambios de requisito

Cuando el creador cambia algo ya decidido:

1. El orquestador registra una decisión nueva con `supersedes_id` apuntando a la anterior.
2. Marca con `needs_reeval` las tareas afectadas.
3. Las tareas afectadas que estén en `ready` o `pending` vuelven a pasar por el
   orquestador antes de ejecutarse.
4. Las tareas afectadas que estén en `in_progress` terminan su ejecución en curso. El
   aviso les llega en la siguiente ejecución (decisión D12).
5. Los incrementos ya publicados que respondían a la decisión antigua se marcan para
   reevaluación. El reviewer decide si siguen siendo válidos.
6. El trabajo no afectado continúa sin interrupción.

## 7.10 Preguntas de los agentes y tareas bloqueadas

Si un agente deja preguntas en el campo `questions` de su resultado, cada una se guarda
como mensaje al orquestador y se publica en el chat con el rol del agente como autor. El
supervisor pide un turno del orquestador sin esperar al creador. Lo mismo cuando una
tarea queda bloqueada.

El orquestador contesta con una nota a la tarea (`notes` del plan), que el agente recibe
en su siguiente ejecución, y si con la respuesta la tarea ya puede seguir, la reabre
(`reopen`). El creador también puede reabrir una tarea bloqueada desde la web, con una
frase que el agente leerá (decisión D46).

## 7.11 Autorizaciones y paradas

Si el motor pide autorización para una acción, el worker crea un registro en `approvals`
y publica `approval.requested`. La web lo muestra de forma destacada. La ejecución queda
esperando hasta que el creador responde o hasta que vence el tiempo de espera
configurado, en cuyo caso se deniega y la tarea pasa a `blocked`.

Si el creador pide parar una ejecución, el worker termina el proceso del motor, marca la
ejecución como `cancelled` y deja el worktree intacto para poder inspeccionarlo.

## 7.12 Falta de cuota

Si el motor informa de falta de cuota o de fallo de autenticación:

1. La ejecución se marca como fallida con ese motivo, sin contar como intento.
2. Las tareas de ese motor pasan a `blocked` con el motivo `quota`.
3. Se publica `quota.exhausted`. La web lo muestra en la cabecera del proyecto.
4. El supervisor deja de arrancar workers de ese motor.
5. El creador decide cuándo reanudar. No se cambia a una modalidad de pago
   automáticamente (decisión D18).

## 7.13 Recuperación tras un reinicio

Al arrancar, el servicio busca ejecuciones en estado `running`. No pueden existir, porque
sus procesos ya no están. Las marca como `interrupted`, devuelve sus tareas a `ready` y
anota el motivo. Los worktrees se conservan: el siguiente intento reutiliza el que ya
existe para esa tarea.

La detección de workers caídos mientras el sistema sigue funcionando pertenece a la fase
2 y usa la tabla `leases`.

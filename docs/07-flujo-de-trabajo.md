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
3. Si la tarea toca código, el worker crea el worktree:
   `git worktree add ../workspaces/<id de tarea> -b task/<id de tarea> <rama principal>`.
4. Si el proyecto define `install_command`, el worker lo ejecuta en el worktree.
5. El worker construye el encargo del documento 05 y lanza el motor.
6. Mientras el motor trabaja, el worker publica eventos `run.progress`.
7. Al terminar, el worker lee `.codehive/result.json`, lo valida y guarda el resultado.

Si el fichero de resultado falta o no valida, la ejecución se marca como fallida con ese
motivo y la tarea vuelve a `ready` si le quedan intentos.

## 7.4 Revisión

1. Una tarea de tipo `build` que termina con `outcome` igual a `completed` y con commit
   pasa a `in_review`, y el servicio crea una tarea de tipo `review` para el reviewer,
   con el identificador del incremento.
2. La tarea de construcción no ocupa worker mientras está en revisión. El builder puede
   tomar otra tarea. Esto es lo que cumple el requisito A02.
3. El reviewer ejecuta la tarea de revisión sobre el commit indicado.
4. Si devuelve hallazgos, cada uno se guarda y los de gravedad `blocker` o `major` crean
   una tarea de tipo `fix` para el rol builder, con prioridad más alta que la de la tarea
   original.
5. La tarea de construcción vuelve a `ready` si hay hallazgos bloqueantes. Si no los hay,
   pasa a `done` y queda a la espera de integración.

## 7.5 Corrección

Una tarea de tipo `fix` recibe el hallazgo completo, incluida la condición para darlo por
resuelto, y trabaja sobre la misma rama que el incremento con el problema.

La corrección produce un incremento nuevo. Ese incremento genera una tarea de revisión
nueva. La aprobación del incremento anterior no se traslada.

Cuando el reviewer aprueba el incremento que corrige un hallazgo, el hallazgo pasa a
`fixed`.

**Contra los bucles.** Si una tarea de corrección supera `max_task_attempts`, pasa a
`blocked` con el motivo, se avisa al orquestador y se registra el historial de intentos.
El orquestador decide si reformula la tarea o la lleva al creador.

**Contra el hambre de tareas antiguas.** La prioridad efectiva de una tarea baja un punto
por cada hora que lleva en estado `ready`. Una tarea antigua acaba adelantando a
correcciones menores recién creadas. El ajuste se calcula en la consulta de la cola, no
se guarda.

## 7.6 Trabajo simultáneo sobre el mismo proyecto

Cada tarea que toca código tiene su worktree y su rama. Dos builders pueden trabajar a la
vez si sus patrones de ruta reservados no se solapan.

Si el orquestador crea dos tareas que reservan el mismo patrón, la segunda no es
reclamable hasta que la primera libera su bloqueo. La web muestra la espera con el motivo.

Cuando dos tareas necesitan cambiar la misma interfaz, la salida correcta es una sola
tarea que acuerde el contrato y dos tareas dependientes que lo usen.

## 7.7 Integración

La integración la confirma el creador (decisión D04).

1. La web muestra la tarea como lista para integrar cuando está en `done`, tiene commit y
   no tiene hallazgos bloqueantes abiertos.
2. El creador pulsa integrar.
3. El servicio actualiza la rama principal, intenta fusionar la rama de la tarea y
   ejecuta `verify_command`.
4. Si la fusión da conflicto, la tarea vuelve a `ready` con el motivo y el builder
   resuelve el conflicto en su worktree.
5. Si las verificaciones fallan tras fusionar, la fusión se deshace, se abre un hallazgo
   de gravedad `blocker` y se crea una tarea de corrección.
6. Si todo pasa, se publica `integration.completed`, se libera el bloqueo de recursos y
   se elimina el worktree.

Una revisión aprobada sobre una rama aislada no garantiza que la integración funcione.
El paso 5 existe por eso.

## 7.8 Cambios de requisito

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

## 7.9 Autorizaciones y paradas

Si el motor pide autorización para una acción, el worker crea un registro en `approvals`
y publica `approval.requested`. La web lo muestra de forma destacada. La ejecución queda
esperando hasta que el creador responde o hasta que vence el tiempo de espera
configurado, en cuyo caso se deniega y la tarea pasa a `blocked`.

Si el creador pide parar una ejecución, el worker termina el proceso del motor, marca la
ejecución como `cancelled` y deja el worktree intacto para poder inspeccionarlo.

## 7.10 Falta de cuota

Si el motor informa de falta de cuota o de fallo de autenticación:

1. La ejecución se marca como fallida con ese motivo, sin contar como intento.
2. Las tareas de ese motor pasan a `blocked` con el motivo `quota`.
3. Se publica `quota.exhausted`. La web lo muestra en la cabecera del proyecto.
4. El supervisor deja de arrancar workers de ese motor.
5. El creador decide cuándo reanudar. No se cambia a una modalidad de pago
   automáticamente (decisión D18).

## 7.11 Recuperación tras un reinicio

Al arrancar, el servicio busca ejecuciones en estado `running`. No pueden existir, porque
sus procesos ya no están. Las marca como `interrupted`, devuelve sus tareas a `ready` y
anota el motivo. Los worktrees se conservan: el siguiente intento reutiliza el que ya
existe para esa tarea.

La detección de workers caídos mientras el sistema sigue funcionando pertenece a la fase
2 y usa la tabla `leases`.

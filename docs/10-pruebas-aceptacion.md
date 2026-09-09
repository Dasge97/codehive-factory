# 10 · Pruebas de aceptación

Una fase no se da por terminada hasta que sus pruebas pasan y el resultado se puede
enseñar. Cada prueba dice qué se hace y qué hay que ver.

## Estado de la fase 1, a 6 de septiembre de 2026

| Prueba | Estado | Dónde se comprueba |
| --- | --- | --- |
| P1-01 Dos tareas independientes a la vez | Pasa | `supervisor.test.ts`: dos worktrees, dos ramas, dos incrementos y ejecuciones solapadas. |
| P1-02 Una corrección entra mientras sigue otro trabajo | Pasa | `review.test.ts`, bloque «revisión con hallazgos». |
| P1-03 Dos workers no reclaman la misma tarea | Pasa | `queue.test.ts`, prueba «dos workers a la vez». |
| P1-04 Los bloqueos impiden el trabajo simultáneo sobre lo mismo | Pasa | `queue.test.ts`, bloque «bloqueos de recursos». |
| P1-05 El sistema se recupera de un reinicio | Pasa | `supervisor.test.ts`, bloque «recuperación tras un reinicio». |
| P1-06 Un cambio de requisito conserva el trabajo compatible | Pasa | `integration.test.ts`, bloque «cambio de requisito». |
| P1-07 Un conflicto de integración se gestiona | Pasa | `integration.test.ts`, bloque «conflicto al fusionar». |
| P1-08 Una integración que rompe las verificaciones se deshace | Pasa | `integration.test.ts`, bloque «la verificación falla tras fusionar». |
| P1-09 Una corrección en bucle se detiene | Pasa | `runner.test.ts`, límite de intentos. |
| P1-10 La falta de cuota pausa sin romper nada | Pasa | `supervisor.test.ts`, bloque «falta de cuota». |
| P1-11 Una petición de autorización llega al creador | Pasa | `runner.test.ts`, bloque «autorizaciones y consumo». |
| P1-12 El creador integra | Pasa, y también con agentes reales | `integration.test.ts` y el apartado siguiente. |
| P1-13 La web refleja el estado real | Pasa | `api.test.ts`, canal de eventos en vivo. |
| P1-14 Recorrido completo del creador | Con agentes reales, solo el camino sin hallazgos hasta el 9 de septiembre | Ver «Tercera ejecución real» al final. |

Las 14 pruebas automáticas pasan. Hasta el 9 de septiembre de 2026, la ejecución real de
P1-14 no había incluido ninguna corrección: las dos ejecuciones reales de los apartados
siguientes fueron aprobadas sin hallazgos. La tercera ejecución real, al final de este
documento, es la que fuerza fallos.

## Primera ejecución real de principio a fin

El 6 de septiembre de 2026 el sistema completó su primer trabajo con agentes reales sobre
su propio repositorio.

1. El creador pidió por el chat una guía de arranque en un fichero nuevo.
2. El orquestador creó una única tarea para el builder y respondió explicando el reparto.
3. El builder trabajó en su worktree, escribió el fichero y publicó un commit.
4. La tarea pasó a revisión y se creó automáticamente la tarea del reviewer.
5. El reviewer revisó ese commit y lo aprobó sin hallazgos.
6. El creador integró desde la API. La rama se fusionó, `npm test` pasó, y el worktree y
   la rama se eliminaron.

El documento producido está en `docs/12-guia-de-arranque.md`. El consumo total fue el 8 %
de la ventana de cinco horas de la suscripción.

**Tres fallos que salieron de esta prueba** y que las pruebas automáticas no habrían
encontrado, corregidos en las decisiones D26, D27 y D28: el builder no podía ejecutar
ninguna orden, una tarea se reintentó 32 veces, y una tarea de revisión aparecía como
integrable.

## Fase 1

### P1-01 · Dos tareas independientes avanzan a la vez

**Qué se hace.** El creador pide dos cambios que tocan ficheros distintos.

**Qué hay que ver.** Dos ejecuciones solapadas en el tiempo, dos worktrees distintos, dos
ramas y dos commits separados. En la web, dos agentes con tarea activa al mismo tiempo.

### P1-02 · Una corrección entra mientras otro trabajo sigue

**Qué se hace.** El reviewer abre un hallazgo bloqueante sobre un incremento mientras hay
otra tarea en curso.

**Qué hay que ver.** El hallazgo, la tarea de corrección creada y vinculada, y la tercera
tarea avanzando sin haberse detenido en ningún momento.

### P1-03 · Dos workers no reclaman la misma tarea

**Qué se hace.** Prueba automática que lanza dos reclamaciones simultáneas sobre la misma
tarea.

**Qué hay que ver.** Una reclamación se queda con la tarea. La otra recibe cero filas
afectadas y vuelve a consultar la cola. No hay dos ejecuciones activas para esa tarea.

### P1-04 · Los bloqueos de recursos impiden el trabajo simultáneo sobre lo mismo

**Qué se hace.** Se crean dos tareas que reservan el mismo patrón de ruta.

**Qué hay que ver.** La segunda no aparece en la cola mientras la primera está activa. La
web muestra la espera con su motivo. Al terminar la primera, la segunda pasa a estar
disponible.

### P1-05 · El sistema se recupera de un reinicio

**Qué se hace.** Se mata el proceso principal con una ejecución en curso y se vuelve a
arrancar.

**Qué hay que ver.** La ejecución queda marcada como interrumpida. La tarea vuelve al
estado listo con el motivo anotado. El worktree se conserva. La web muestra el estado
real al reconectar.

### P1-06 · Un cambio de requisito conserva el trabajo compatible

**Qué se hace.** El creador cambia un requisito con tareas ya en marcha.

**Qué hay que ver.** Una decisión nueva que sustituye a la anterior. Solo las tareas
afectadas quedan marcadas para reevaluar. Las no afectadas siguen sin tocarse.

### P1-07 · Un conflicto de integración se gestiona

**Qué se hace.** Se integra una rama cuya fusión da conflicto con la rama principal.

**Qué hay que ver.** La integración no se completa. La tarea vuelve a estar lista con el
motivo. El builder resuelve el conflicto en su worktree y la integración se reintenta.

### P1-08 · Una integración que rompe las verificaciones se deshace

**Qué se hace.** Se integra una rama que fusiona bien pero hace fallar el comando de
verificación del proyecto.

**Qué hay que ver.** La fusión se revierte, se abre un hallazgo bloqueante y se crea una
tarea de corrección. La rama principal queda como estaba.

### P1-09 · Una corrección en bucle se detiene

**Qué se hace.** Se fuerza una tarea de corrección que falla repetidamente.

**Qué hay que ver.** Al superar el número máximo de intentos, la tarea pasa a bloqueada
con el historial de intentos y el motivo. El orquestador recibe el aviso. No hay
reintentos infinitos.

### P1-10 · La falta de cuota pausa sin romper nada

**Qué se hace.** Se simula una respuesta de falta de cuota del motor.

**Qué hay que ver.** Las tareas afectadas quedan bloqueadas conservando su estado. El
supervisor deja de arrancar workers. La web lo muestra en la cabecera. No se activa
ninguna modalidad de pago.

### P1-11 · Una petición de autorización llega al creador

**Qué se hace.** Un agente intenta una acción que requiere permiso.

**Qué hay que ver.** La petición aparece en la web sin posibilidad de ocultarla, indica
qué se pide y en qué tarea, y la ejecución continúa o se deniega según la respuesta.

### P1-12 · El creador integra desde la web

**Qué se hace.** Una tarea con revisión aprobada y sin hallazgos bloqueantes.

**Qué hay que ver.** La web ofrece integrar, muestra rama, commits y ficheros antes de
confirmar, ejecuta la verificación y publica el resultado. El worktree se elimina y el
bloqueo de recursos se libera.

### P1-13 · La web refleja el estado real

**Qué se hace.** Se corta el canal de eventos y se vuelve a conectar.

**Qué hay que ver.** Mientras está cortado, la web avisa de que la información puede estar
desactualizada y no simula progreso. Al reconectar recupera los eventos perdidos.

### P1-14 · Recorrido completo del creador

**Qué se hace.** El creador pide un cambio en el chat y no vuelve a tocar nada hasta que
llega el momento de integrar.

**Qué hay que ver.** Tareas creadas, construcción, revisión, al menos una corrección,
revisión de la corrección y una integración confirmada por el creador. Todo el recorrido
consultable desde la web sin leer registros a mano.

---

## Fase 2

Las seis pruebas pasan. Estado a 6 de septiembre de 2026.

| Prueba | Estado | Dónde se comprueba |
| --- | --- | --- |
| P2-01 Dos workers del mismo rol trabajan a la vez | Pasa | `supervisor.test.ts`, bloque «dos tareas independientes avanzan a la vez». |
| P2-02 Un worker caído se detecta y su tarea se reasigna | Pasa | `leases.test.ts`, bloque «un worker caído se detecta». |
| P2-03 Un resultado tardío no sobrescribe el estado vigente | Pasa | `leases.test.ts`, bloque «un resultado tardío». |
| P2-04 Un agente pide ayuda a otro | Pasa | `agent-messages.test.ts` y `runner.test.ts`, petición de apoyo de punta a punta. |
| P2-05 Una conversación entre agentes no entra en bucle | Pasa | `agent-messages.test.ts`, escalado al sexto mensaje. |
| P2-06 Dos motores colaboran en el mismo proyecto | Pasa con agentes reales | Ver el apartado siguiente. |

### P2-01 · Dos workers del mismo rol trabajan a la vez

**Qué hay que ver.** Dos builders con tareas distintas en curso, sin conflicto de
recursos y sin reclamar la misma tarea.

### P2-02 · Un worker caído se detecta y su tarea se reasigna

**Qué se hace.** Se deja caducar la vigencia de una asignación con la tarea en curso.

**Qué hay que ver.** La tarea vuelve a estar disponible y otro worker la toma. Si el
worker perdido llegó a publicar un incremento, la tarea pasa a revisión en lugar de
volver a construirse desde cero.

### P2-03 · Un resultado tardío no sobrescribe el estado vigente

**Qué se hace.** Un worker dado por perdido devuelve su resultado después de que la tarea
se haya reasignado.

**Qué hay que ver.** El resultado se registra como descartado con su motivo y su resumen.
El estado vigente no cambia. No se crean incrementos duplicados.

### P2-04 · Un agente pide ayuda a otro

**Qué se hace.** El builder declara en su resultado que necesita saber algo del proyecto.

**Qué hay que ver.** Una tarea de apoyo con responsable, puesta como dependencia de la
tarea que la pidió. La tarea original espera en lugar de reintentar a ciegas. Mientras el
apoyo esté abierto, la tarea no se puede reclamar, así que no pide lo mismo dos veces.

### P2-05 · Una conversación entre agentes no entra en bucle

**Qué se hace.** Dos agentes intercambian mensajes sin llegar a una conclusión.

**Qué hay que ver.** Al séptimo mensaje, el asunto se escala al orquestador con lo que se
ha dicho hasta ese punto.

### P2-06 · Dos motores colaboran en el mismo proyecto

**Qué se hace.** El builder se configura con Claude Code y el reviewer con Codex.

**Qué hay que ver.** El reviewer revisa un incremento producido por el otro motor y
publica su veredicto en el mismo formato.

## Segunda ejecución real, con los dos motores

El 6 de septiembre de 2026 el creador pidió por el chat una sección para el fichero
README.md. Claude Code la escribió y publicó su commit. Codex revisó ese commit y lo
aprobó sin hallazgos. El creador integró: la rama se fusionó y `npm test` pasó.

En las ejecuciones se ve la diferencia entre los dos motores: Claude Code informa del
coste en dinero de su ejecución, y Codex solo informa de los tokens, tal como declara su
adaptador en la lista de capacidades.

**Tres fallos que salieron de esta prueba**, corregidos en las decisiones D35, D36, D37 y
D38: Codex rechazaba los esquemas de resultado por no declarar todas las propiedades como
obligatorias, las peticiones de apoyo se encadenaban sin fin, y una revisión no se cerraba
al dar su veredicto. Además, en Windows el aislamiento propio de Codex impedía al reviewer
ejecutar cualquier orden, así que no podía ni mirar el commit.

## Tercera ejecución real: forzando fallos

El 9 de septiembre de 2026, sobre un proyecto pequeño de Node aparte (una lista de la
compra con `node --test` como verificación y `package.json` protegido), con todos los roles
en Claude Code 2.1.153, dos workers de builder y el proyecto en modo normal salvo la última
ronda. Doce peticiones por el chat, veintidós tareas, veintiocho ejecuciones. Coste informado
por el motor: 8,10 dólares en ejecuciones y 2,19 en catorce turnos del orquestador.

| Qué se forzó | Qué hizo el sistema |
| --- | --- |
| Dos peticiones independientes en un mensaje | El orquestador creó dos tareas con rutas distintas; los dos builders trabajaron a la vez; dos revisiones aprobadas; dos integraciones. |
| Integrar con un fichero sin confirmar en el repositorio del creador | Se negó sin tocar nada y dijo por qué. Sin el fichero, integró. |
| La rama principal cambió mientras el builder trabajaba: una prueba nueva fija la lista de funciones exportadas, y la tarea añadía una | La revisión aprobó la rama aislada. Al integrar, la fusión pasó y `node --test` falló. La fusión se deshizo, se abrió un hallazgo bloqueante y la misma tarea volvió a la cola. El builder fusionó `main` en su rama, actualizó la prueba, el reviewer aprobó, y la integración pasó. |
| Una tarea que exige tocar `package.json`, protegido | El builder no lo tocó, terminó bloqueado y dejó una pregunta. La pregunta llegó al chat y provocó un turno del orquestador. El creador contestó; el orquestador canceló la tarea y registró la decisión. |
| Un cambio que rompe una prueba existente, con orden de preguntar antes | El orquestador leyó la prueba, no creó ninguna tarea y preguntó al creador con cuatro opciones. Con la respuesta, creó la tarea. |
| Matar el proceso principal con el builder a mitad | Al arrancar, la ejecución quedó como interrumpida y la tarea volvió a la cola. El segundo intento encontró en el worktree el commit que el primero había dejado, lo publicó y siguió. |
| Tiempo máximo de 60 segundos en una tarea grande | La primera ejecución se agotó por tiempo. La segunda, con el tiempo normal, terminó. |
| Modo estricto sobre una tarea grande | Construcción, revisión aprobada, limpieza del refactorer, revisión de la limpieza con un hallazgo `major` real («el refactor afloja la validación de cantidad»), la misma tarea de limpieza lo corrigió y añadió una prueba, revisión aprobada, tarea original hecha con el commit final del refactor, integrada. |
| Dos cambios que tocan el mismo fichero en un mensaje | El orquestador creó una sola tarea con las dos cosas, explicó por qué, y preguntó un criterio de diseño antes de que empezara el builder. El bloqueo por rutas no llegó a hacer falta. |
| Un cambio con la orden expresa de no escribir pruebas | El builder no tocó ningún test y el reviewer aprobó: la orden del creador en la tarea pesó más que su regla de exigir pruebas. |
| Un solo intento permitido y tope de 60 segundos en una tarea grande | Primer intento agotado por tiempo, tarea bloqueada, turno del orquestador: la reabrió él mismo con una nota sobre cómo acortar las pruebas. Segundo intento rechazado por el reviewer con dos hallazgos reales (el CLI no admitía rutas con espacios), y la tarea volvió a bloquearse por agotar las rondas de corrección. El creador la reabrió desde la API; el tercer intento resolvió los dos hallazgos y quedó aprobada e integrada. |

**Fallos del sistema que salieron de esta prueba**, todos corregidos el mismo día:

- Con Claude Code 2.1 el motor ni arrancaba: `--permission-prompts`, `--safe-mode` y el
  modo de permisos `manual` ya no existen. Y el resultado que cumple el esquema viene en el
  campo `structured_output`, no en `result`. Ningún agente podía ejecutarse.
- Claude omite los campos que valen null y el esquema los exigía todos, así que el motor
  rechazaba el plan del orquestador cinco veces seguidas. El adaptador de Claude relaja el
  esquema; el de Codex lo mantiene estricto (decisión D47).
- `git diff base..commit` falla en Windows dentro de un worktree de ruta larga, así que
  ningún incremento traía su lista de ficheros y la comprobación de ficheros protegidos no
  podía funcionar.
- La web esperaba un campo `orchestrator_busy` que el servidor nunca mandaba.
- Cancelar una tarea dejaba su worktree y su rama para siempre.
- Una ejecución interrumpida por un reinicio no apuntaba el proceso del motor; ahora se
  guarda y el arranque lo mata si sigue vivo.

**Lo que no se ha probado con agentes reales:** Codex (en esta máquina no se usa), y un worker perdido con el sistema en marcha. Con los workers dentro del proceso principal (decisión D25), un worker solo se pierde si el proceso del motor se cuelga sin terminar, y ese caso lo cubre el tiempo máximo de ejecución. Las dos siguen cubiertas por las pruebas automáticas.

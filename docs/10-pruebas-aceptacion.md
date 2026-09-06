# 10 · Pruebas de aceptación

Una fase no se da por terminada hasta que sus pruebas pasan y el resultado se puede
enseñar. Cada prueba dice qué se hace y qué hay que ver.

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

### P2-01 · Dos workers del mismo rol trabajan a la vez

**Qué hay que ver.** Dos builders con tareas distintas en curso, sin conflicto de
recursos y sin reclamar la misma tarea.

### P2-02 · Un worker caído se detecta y su tarea se reasigna

**Qué se hace.** Se mata un proceso worker con una tarea en curso.

**Qué hay que ver.** La vigencia de la asignación caduca, la tarea vuelve a estar
disponible y se comprueban antes los efectos ya ejecutados por el worker perdido.

### P2-03 · Un resultado tardío no sobrescribe el estado vigente

**Qué se hace.** Un worker dado por perdido devuelve su resultado después de que la tarea
se haya reasignado.

**Qué hay que ver.** El resultado se registra como descartado con su motivo. El estado
vigente no cambia. No se crean incrementos ni correcciones duplicados.

### P2-04 · Un agente pide ayuda a otro

**Qué se hace.** El builder necesita saber cómo funciona una parte del proyecto.

**Qué hay que ver.** La consulta, la respuesta del investigador o la subtarea creada, y la
aplicación del resultado en el trabajo del builder. Todo el hilo visible en la web.

### P2-05 · Una conversación entre agentes no entra en bucle

**Qué se hace.** Dos agentes intercambian mensajes sin llegar a una conclusión.

**Qué hay que ver.** Al alcanzar el límite de mensajes, el asunto se escala al orquestador
con la evidencia acumulada.

### P2-06 · Dos motores colaboran en el mismo proyecto

**Qué se hace.** El builder se configura con Claude Code y el reviewer con Codex.

**Qué hay que ver.** El reviewer revisa un incremento producido por el otro motor y
publica hallazgos en el mismo formato.

---

## Qué se mide

La validación no se limita a que las pruebas pasen. Se registra también:

- Cuántas tareas se completan y se integran sin intervención del creador.
- Cuántas quedan bloqueadas y por qué.
- Cuántas correcciones necesita de media un incremento antes de aprobarse.
- Cuánto tiempo pasa una tarea esperando en la cola.

Mantener a todos los agentes ocupados no es una medida de éxito.

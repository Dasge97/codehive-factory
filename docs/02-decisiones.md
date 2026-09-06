# 02 · Decisiones

Registro de todas las decisiones tomadas. Cada una indica quién la tomó, por qué y qué
alternativas se descartaron. Una decisión solo cambia añadiendo una entrada nueva que
la sustituya; las entradas antiguas no se borran.

Origen: **creador** cuando la eligió el creador, **técnica** cuando la fijó el diseño
dentro del margen que el creador dejó abierto.

Fecha de cierre de todas las decisiones de esta lista: 6 de septiembre de 2026.

---

## D01 · El sistema se ejecuta en el PC Windows del creador

**Origen:** creador.

El servicio de coordinación, la base de datos, los motores de ejecución y los espacios
de trabajo viven en el equipo del creador.

**Por qué:** usa las sesiones ya autenticadas de Claude Code, accede directamente a los
proyectos del disco y no exige mantener un servidor.

**Consecuencia:** si el equipo se apaga, el trabajo se detiene. Al arrancar de nuevo, el
sistema recupera el estado desde la base de datos y las tareas que estaban en curso
vuelven al estado listo.

**Descartado:** servidor Linux siempre encendido, porque obliga a replicar la
autenticación de las suscripciones y a subir los proyectos. Modelo híbrido con el
coordinador en servidor y los motores en local, porque añade un canal entre las dos
mitades que hay que construir y mantener.

---

## D02 · Node con TypeScript y base de datos SQLite

**Origen:** creador.

Backend y web en TypeScript. Persistencia en un fichero SQLite en modo WAL.

**Por qué:** un solo lenguaje para el servicio y la web permite compartir los tipos de
tarea, evento y mensaje. SQLite da transacciones reales, que es lo que hace falta para
que dos workers no reclamen la misma tarea, y no exige instalar ni administrar un
servidor de base de datos.

**Descartado:** PostgreSQL, porque su ventaja es la concurrencia alta y el acceso
remoto, y aquí hay un usuario y pocos workers. Python, porque obligaría a definir los
tipos de datos dos veces al no compartir lenguaje con la web.

---

## D03 · La implementación se parte en dos fases

**Origen:** creador.

Fase 1: un worker por rol, cola persistente, ciclo builder-reviewer, chat con el
orquestador y web de estado. Fase 2: varios workers por agente, detección de workers
caídos, mensajes entre agentes y control de resultados tardíos.

**Por qué:** el conjunto completo es un sistema distribuido. Partirlo entrega antes algo
que funciona y permite probar el sistema con trabajo real antes de añadir la parte
difícil.

**Descartado:** construir todo de una vez, porque retrasa el primer resultado utilizable
y mezcla fallos de diseño con fallos de concurrencia.

**Relación con los requisitos:** A02, A05 y A06 se cumplen parcialmente en la fase 1,
donde cuatro agentes distintos trabajan a la vez con un worker cada uno, y por completo
en la fase 2.

---

## D04 · Los agentes trabajan solos hasta la integración

**Origen:** creador.

Los agentes crean ramas, escriben ficheros, ejecutan pruebas y se revisan entre ellos
sin pedir permiso. Fusionar a la rama principal requiere confirmación del creador en la
web. Los agentes nunca hacen push a un remoto ni despliegan.

**Por qué:** el trabajo desatendido tiene sentido solo si no pide permiso a cada paso.
El punto donde un error se vuelve caro es la integración, y ahí es donde interviene el
creador.

**Descartado:** integración automática al aprobar el reviewer, porque un fallo del
reviewer entraría en la rama principal sin que el creador lo vea. Confirmación de cada
escritura de fichero, porque elimina en la práctica el trabajo desatendido.

---

## D05 · Solo Claude Code como motor en la fase 1

**Origen:** creador.

Los cuatro roles se ejecutan con Claude Code. El adaptador de Codex se construye en la
fase 2.

**Por qué:** un único adaptador que construir y validar. Arranca antes.

**Consecuencia:** todo el consumo sale de la suscripción de Claude. Si se agota la
cuota, el sistema entero se para. El comportamiento ante falta de cuota está definido en
la decisión D18.

**Descartado:** Claude para construir y Codex para revisar desde el principio, porque
duplica el trabajo de integración antes de haber validado el flujo. Motor configurable
por agente desde la fase 1, por el mismo motivo.

---

## D06 · Web en React con Vite, servida solo en la red local

**Origen:** creador.

La web se construye con React y Vite. La sirve el mismo proceso local. Se abre desde el
navegador del equipo y desde el móvil usando la dirección IP del equipo en la red local.
No lleva autenticación en la fase 1.

**Por qué:** el sistema es de un solo usuario y no sale de la red doméstica. Añadir
autenticación y exposición a internet es superficie de seguridad sin beneficio hasta que
haga falta.

**Consecuencia:** cualquiera conectado a la misma red local puede abrir la web y dar
órdenes al sistema. Se acepta ese riesgo.

**Descartado:** acceso desde fuera de la red local, aplazado. Next.js, porque su
renderizado en servidor y su enrutado aportan poco a una pantalla que muestra estado en
vivo.

---

## D07 · El proyecto piloto es el propio Code Hive Factory

**Origen:** creador.

Cuando la fase 1 funcione, el primer proyecto real que gestionará el sistema es su
propia fase 2.

**Por qué:** el creador conoce el código, no hay riesgo para un proyecto en producción y
los fallos del sistema se manifiestan de inmediato en el trabajo que produce.

---

## D08 · Repositorio público Dasge97/codehive-factory

**Origen:** creador.

El código y la documentación viven en un repositorio público de GitHub.

**Consecuencia:** ni la documentación ni el código pueden contener credenciales, tokens,
rutas de proyectos privados del creador, volcados de la base de datos ni contenido de
los espacios de trabajo. El fichero `.gitignore` bloquea esas rutas.

---

## D09 · Aislamiento por worktree de Git, una rama por tarea

**Origen:** técnica.

Cada tarea que modifica código se ejecuta en un worktree propio creado con
`git worktree add`, sobre una rama llamada `task/` seguida del identificador de la tarea.

**Por qué:** los worktrees comparten el historial del repositorio pero tienen directorio
de trabajo separado. Dos workers pueden editar ficheros distintos del mismo proyecto sin
pisarse y sin clonar el repositorio entero por tarea.

**Descartado:** clonar el repositorio por tarea, porque multiplica el espacio en disco y
el tiempo de preparación. Trabajar todos sobre el mismo directorio, porque hace
imposible la concurrencia.

**Limitación conocida:** cada worktree de un proyecto de Node necesita su propia
instalación de dependencias. El coste en tiempo y disco se acepta.

---

## D10 · Un incremento es un commit en la rama de la tarea

**Origen:** técnica.

El builder hace commit cuando tiene un resultado coherente. Ese commit es el incremento.
El reviewer revisa un identificador de commit concreto, nunca el directorio de trabajo.

**Por qué:** el reviewer necesita una versión estable e identificable. Sin ella revisa
ficheros a medio escribir y sus hallazgos no se pueden vincular a nada.

---

## D11 · La reclamación de tareas es una transacción SQLite

**Origen:** técnica.

Un worker reclama una tarea con una única sentencia UPDATE que cambia el estado a
`in_progress` solo si el estado sigue siendo `ready` y no hay asignación activa. Si la
sentencia afecta a cero filas, otro worker se adelantó y este worker vuelve a consultar
la cola.

**Por qué:** es el mecanismo más simple que garantiza que dos workers no se conviertan en
responsables de la misma tarea. No hace falta un servidor de colas.

**Descartado:** una cola en memoria del proceso coordinador, porque el estado se pierde
al reiniciar. Un sistema de colas externo como Redis, por complejidad innecesaria a esta
escala.

---

## D12 · El punto seguro para interrumpir un worker es el final de una ejecución

**Origen:** técnica.

Una ejecución de un motor no se interrumpe a mitad. Cuando llega un aviso relevante
mientras un worker trabaja, el aviso se guarda y se le entrega en la siguiente ejecución
sobre esa tarea. La única excepción es una orden de parada del creador, que termina el
proceso del motor y marca la ejecución como cancelada.

**Por qué:** el motor de ejecución es un proceso externo. Matarlo a mitad puede dejar
ficheros a medio escribir en el worktree. No hay forma de inyectar información en una
sesión ya lanzada.

**Consecuencia sobre el requisito A04:** una corrección detectada por el reviewer entra
en el trabajo activo creando una tarea nueva que otro worker puede tomar de inmediato, o
que el builder toma al terminar su ejecución en curso. No interrumpe la ejecución
actual. Esto cumple A04, que pide no esperar a otra fase del proyecto, no ejecución
instantánea.

---

## D13 · Los recursos compartidos se reservan por patrón de ruta

**Origen:** técnica.

Una tarea puede declarar patrones de ruta que va a modificar. Al reclamarla, el worker
adquiere un bloqueo sobre esos patrones dentro de la misma transacción de reclamación.
Una tarea cuyos patrones se solapan con un bloqueo activo no es reclamable y espera.

**Por qué:** es lo que evita que dos tareas cambien la misma interfaz compartida en
paralelo y produzcan un conflicto imposible de resolver automáticamente.

**Quién declara los patrones:** el orquestador al crear la tarea. Si un agente descubre
durante la ejecución que necesita tocar un fichero fuera de su reserva, lo registra como
bloqueo y el orquestador decide.

---

## D14 · La web recibe el estado por HTTP y Server-Sent Events

**Origen:** técnica.

Las consultas y las acciones del creador van por HTTP. Las actualizaciones en vivo
llegan por un canal de Server-Sent Events desde el servicio de coordinación.

**Por qué:** el flujo de información es casi todo del servidor hacia la web. Server-Sent
Events reconecta solo y es mucho más simple que WebSocket.

**Descartado:** WebSocket, porque su ventaja es el tráfico bidireccional intenso, que
aquí no existe. Consultar en bucle desde la web, porque retrasa la información y gasta
recursos.

---

## D15 · Cuatro agentes con un worker cada uno en la fase 1

**Origen:** técnica, dentro de la fase 1 que eligió el creador.

Orquestador, builder, reviewer e investigador. Un worker por agente. El número de workers
por agente es configurable, pero la fase 1 se prueba y se entrega con uno.

**Por qué:** cuatro procesos concurrentes ya demuestran trabajo simultáneo y bastan para
el ciclo builder-reviewer. Varios workers del mismo rol añaden problemas de reparto que
pertenecen a la fase 2.

---

## D16 · El orquestador es una sesión de motor con herramientas limitadas

**Origen:** técnica.

El orquestador se ejecuta como una sesión de Claude Code cuyas herramientas son las del
registro de tareas: crear tarea, cambiar prioridad, marcar bloqueo, registrar decisión y
consultar estado. No tiene acceso de escritura al código de los proyectos.

**Por qué:** separa quién decide de quién ejecuta. Un orquestador que además escribe
código tiende a hacer el trabajo él mismo en vez de repartirlo.

---

## D17 · El servicio de coordinación no llama a ningún modelo

**Origen:** técnica.

Las transiciones de estado, la asignación de tareas, los bloqueos y las actualizaciones
de la web las decide código normal. Los modelos solo se invocan para ejecutar el trabajo
de un agente.

**Por qué:** hace el sistema predecible, barato y depurable. Un fallo de coordinación se
reproduce con una prueba, no con una nueva llamada al modelo.

---

## D18 · Límites de consumo y comportamiento ante falta de cuota

**Origen:** técnica.

Configurables por proyecto: número máximo de ejecuciones simultáneas, número máximo de
reintentos por tarea y número máximo de mensajes en una conversación entre agentes.

Si un motor devuelve falta de cuota o fallo de autenticación, las tareas afectadas pasan
a bloqueadas con ese motivo y conservan su estado. El sistema no cambia a una modalidad
de pago por su cuenta ni reintenta en bucle.

---

## D19 · Todo el sistema está en español

**Origen:** técnica, siguiendo la preferencia del creador.

Documentación, interfaz web, mensajes al creador e instrucciones de los agentes en
español. Los identificadores del código y del esquema de base de datos en inglés, por
convención del lenguaje.

---

## D20 · La fase 0 valida el motor antes de construir nada

**Origen:** técnica.

Antes de escribir el servicio de coordinación se comprueba con Claude Code: ejecución
programática con salida estructurada, continuidad de una sesión entre ejecuciones,
respuesta ante una petición de autorización, parada de una ejecución, detección de falta
de cuota y dos ejecuciones simultáneas en worktrees distintos.

**Por qué:** todo el diseño supone capacidades del motor que no se han probado con la
cuenta del creador. Si alguna no está disponible, cambia el diseño y es mejor saberlo
antes.

---

## Decisiones aún abiertas

| Tema | Cuándo se decide |
| --- | --- |
| Estilo visual concreto: colores, tipografía e identidad. | Al empezar la tarea de diseño de la interfaz, en la fase 1. |
| Forma exacta del adaptador de Codex. | Al empezar la fase 2, con la documentación vigente en esa fecha. |
| Si el sistema pasa a un servidor siempre encendido. | Cuando el uso real demuestre que hace falta. |

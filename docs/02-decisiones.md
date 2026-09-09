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

## D21 · El resultado del agente se valida con un esquema del motor

**Origen:** técnica, tras la fase 0.

El worker pasa un esquema JSON al motor con la opción `--json-schema`. El motor devuelve
un resultado que cumple ese esquema. El worker lo valida otra vez antes de guardarlo.

**Por qué:** el motor hace cumplir el formato. El worker no depende de que el agente
escriba correctamente un fichero.

**Sustituye a:** el fichero `.codehive/result.json` que estaba en el documento 05 antes
de la fase 0. La comprobación F0-08 confirmó que la opción del motor funciona.

---

## D22 · Las autorizaciones se resuelven entre ejecuciones

**Origen:** técnica, tras la fase 0.

El worker ejecuta con `--permission-prompts none`, así que cualquier acción que necesite
permiso se deniega automáticamente. La ejecución continúa y la denegación queda en el
campo `permission_denials` del evento final, con la herramienta y sus argumentos exactos.
El worker convierte cada denegación en una petición de autorización para el creador. Si
el creador la aprueba, la siguiente ejecución de la tarea añade esa herramienta a las
permitidas.

**Por qué:** no hace falta un servidor MCP que atienda permisos en tiempo real. Encaja
con la decisión D12, que fija el final de una ejecución como punto seguro.

**Consecuencia:** una acción que necesita permiso no se ejecuta en el mismo intento. El
agente sigue trabajando en lo que sí puede hacer y el creador decide después.

---

## D23 · Cada ejecución tiene un tiempo máximo

**Origen:** técnica, tras la fase 0.

El adaptador aplica un tiempo máximo configurable por proyecto. Al superarlo, mata el
proceso del motor y marca la ejecución como agotada por tiempo.

**Por qué:** en la comprobación F0-06, un fallo de autenticación tardó más de dos minutos
en producirse porque el motor reintenta antes de rendirse. Sin un tiempo máximo, un
problema de credenciales bloquea un worker durante minutos.

---

## D24 · El orquestador devuelve un plan, no llama a herramientas

**Origen:** técnica, durante la fase 1.

El orquestador recibe el estado completo del proyecto y devuelve de una vez un plan: su
respuesta al creador, las tareas nuevas, las decisiones que registrar, los cambios de
prioridad y las cancelaciones. El sistema aplica ese plan con código normal.

**Por qué:** dar herramientas al orquestador exigiría levantar un servidor MCP propio y
mantener una sesión abierta mientras las llama una a una. Un plan devuelto de golpe se
valida contra un esquema, se aplica de forma determinista y pasa por las mismas
comprobaciones que cualquier otro cambio.

**Consecuencia:** el orquestador no puede consultar el estado a mitad de su turno. No hace
falta: lo recibe entero en su encargo.

**Sustituye a:** la lista de herramientas del apartado 5.6 del documento de contratos.

---

## D25 · Los workers son tareas asíncronas, no procesos separados

**Origen:** técnica, durante la fase 1.

Cada worker es una tarea asíncrona dentro del proceso principal. El motor sí es un
proceso externo.

**Por qué:** el aislamiento real ya lo da el proceso del motor, que corre en su propio
worktree. Un proceso hijo por worker obligaría a construir un canal de comunicación con
el proceso principal sin ganar nada a cambio, porque el worker solo espera al motor.

**Consecuencia:** todo el estado sigue escribiéndose desde un solo proceso, que era el
motivo original de separar los workers. Al parar el sistema hay que esperar a que los
trabajos en vuelo terminen antes de cerrar la base de datos.

**Sustituye a:** el apartado 3.2 del documento de arquitectura.

---

## D26 · Dentro de su worktree, el agente no pide permiso

**Origen:** técnica, tras la primera prueba con agentes reales.

El motor se lanza en modo de permisos abierto. Lo que limita al agente es la lista de
herramientas que se le da y el aislamiento de su worktree, no el prompt de permisos.

**Por qué:** en la primera prueba real, el builder escribió el fichero pedido pero no pudo
hacer `git commit` ni ejecutar las pruebas del proyecto. Con el modo anterior, editar
ficheros estaba permitido y ejecutar cualquier orden se denegaba, y como nadie responde a
los prompts, toda orden se denegaba automáticamente. Un builder que no puede hacer commit
no puede publicar ningún incremento, así que el ciclo entero se quedaba parado.

**Qué sigue protegido:** el agente solo tiene las herramientas de su rol, trabaja en un
worktree separado, y las reglas de no hacer push ni fusionar en la rama principal siguen
en sus instrucciones. La integración sigue necesitando la confirmación del creador
(decisión D04).

**Relación con la decisión D22:** las peticiones de autorización siguen existiendo para lo
que el motor deniegue por su cuenta. Ya no se generan por comandos normales del trabajo.

---

## D27 · El worker confirma lo que el agente deje sin confirmar

**Origen:** técnica, tras la primera prueba con agentes reales.

Si al terminar una ejecución quedan cambios sin confirmar en el worktree, el worker hace
el commit con el resumen del agente como mensaje.

**Por qué:** perder el trabajo de una ejecución entera porque falló el último paso no
tiene sentido. El incremento es lo que el reviewer necesita para trabajar.

---

## D28 · Avanzar sin terminar también gasta intentos

**Origen:** técnica, tras la primera prueba con agentes reales.

Una tarea cuyo agente devuelve que avanzó sin terminar cuenta un intento. Al superar el
máximo del proyecto, la tarea se bloquea con su historial.

**Por qué:** en la primera prueba real, una tarea se ejecutó 32 veces seguidas. El límite
de intentos solo contaba los fallos, y el agente devolvía que había avanzado sin terminar,
que no contaba. Una tarea que nunca se cierra se reintentaba de forma indefinida.

---

## D29 · Una tarea terminada vuelve a la cola si su integración falla

**Origen:** técnica, al escribir las pruebas de aceptación de la integración.

De `done` se puede pasar a `ready`, y solo a `ready`. Es el único camino que sale de una
tarea terminada. Al reabrirla se le quita la fecha de cierre.

**Por qué:** una tarea aprobada sobre su rama aislada puede dar conflicto al fusionar, o
romper las verificaciones una vez fusionada. Con `done` como estado terminal, la
integración fallida no tenía forma de devolver la tarea al trabajo, y el flujo del
apartado 7.7 del documento de flujo de trabajo era imposible de cumplir.

**Qué sigue siendo terminal:** `cancelled`. Una tarea cancelada no vuelve nunca.

---

## D30 · Las asignaciones tienen vigencia renovable

**Origen:** técnica, fase 2.

Reclamar una tarea crea una vigencia que caduca a los 90 segundos. El supervisor la renueva
cada 20 segundos por su propio reloj. Antes de repartir trabajo nuevo, un barrido recupera
las tareas cuya vigencia caducó.

**Por qué:** un worker puede morir sin dejar rastro. Sin vigencia, su tarea se quedaría en
curso para siempre y nadie más podría tomarla.

**Por qué la renovación va por su propio reloj:** si dependiera del ciclo de reparto, un
ciclo lento daría por perdidos a workers que están vivos.

**Qué pasa con el trabajo del worker perdido:** si llegó a publicar un incremento, la tarea
pasa a revisión en lugar de volver a construirse desde cero. Su trabajo no se tira.

---

## D31 · Un resultado tardío no sobrescribe el estado vigente

**Origen:** técnica, fase 2.

Antes de guardar nada, el worker comprueba que su ejecución sigue siendo la vigente de la
tarea. Si otra la sustituyó, el resultado se registra como descartado con su resumen, y no
cambia ningún estado.

**Por qué:** un worker dado por perdido puede volver en sí y terminar. Aplicar su resultado
pisaría el trabajo de quien tomó la tarea después, y podría crear un incremento duplicado.

---

## D32 · Pedir apoyo crea una tarea, y quien la pide espera

**Origen:** técnica, fase 2.

Cuando un agente declara en el campo `needs` de su resultado que necesita algo de otro rol,
el sistema crea una tarea de apoyo con responsable, la pone como dependencia de la tarea que
la pidió, y esa tarea vuelve a pendiente.

**Por qué:** ayudar no es que otro haga tu trabajo sin dejar rastro. Cada petición tiene un
responsable y queda registrada. Y quien pidió el apoyo espera a recibirlo en lugar de
reintentar a ciegas gastando intentos.

**Límite:** como mucho tres peticiones de apoyo por ejecución. Una tarea que pide diez cosas
no está pidiendo apoyo, está mal planteada.

---

## D33 · Una conversación entre agentes se escala al sexto mensaje

**Origen:** técnica, fase 2.

Un hilo de mensajes entre agentes admite seis mensajes. El siguiente se convierte en un
escalado dirigido al orquestador, con lo que se ha dicho hasta ese punto.

**Por qué:** dos agentes que no llegan a nada pueden seguir contestándose sin producir
ningún resultado, gastando cuota. El límite corta ese caso y lleva la decisión a quien
puede tomarla.

---

## D34 · El motor se elige por agente, y la revisión va con el otro

**Origen:** técnica, fase 2.

Cada agente lleva su motor en la base de datos. Por omisión, el orquestador, el builder y
el investigador van con Claude Code, y el reviewer con Codex. Si un motor no está
instalado, los roles que lo pedían caen a Claude Code y el arranque lo dice por consola.

**Por qué:** dos proveedores distintos revisando el trabajo del otro detectan más fallos
que uno revisándose a sí mismo, y reparte el consumo entre las dos suscripciones.

**Comprobado el 6 de septiembre de 2026:** Claude Code escribió una sección del README,
Codex la revisó y la aprobó, y la integración pasó las verificaciones.

---

## D35 · Los esquemas de resultado declaran todas sus propiedades como obligatorias

**Origen:** técnica, fase 2.

Todos los objetos de los esquemas JSON llevan en `required` todas las claves de
`properties`. Los campos que no se usan admiten null.

**Por qué:** Codex rechaza un esquema que no lo cumpla, con un error del tipo «required is
required to be supplied and to be an array including every key in properties». Claude Code
acepta el mismo esquema estricto, así que uno solo vale para los dos motores.

---

## D36 · Solo quien construye pide apoyo, y solo un nivel

**Origen:** técnica, fase 2.

Únicamente las tareas de construcción y de corrección pueden pedir apoyo a otro rol. Una
tarea de apoyo no pide más apoyo.

**Por qué:** en la prueba real, una tarea de apoyo pidió otro apoyo, que pidió otro. La
cadena crecía sola y se alejaba del objetivo. El investigador responde con lo que
encuentra o dice que no se puede saber; el reviewer revisa lo que hay. Ninguno delega.

---

## D37 · Una revisión se cierra al dar su veredicto

**Origen:** técnica, fase 2.

Cuando el reviewer entrega sus hallazgos, o dice que no hay ninguno, su tarea queda hecha,
aunque el agente diga que avanzó sin terminar.

**Por qué:** el trabajo de una revisión es dar el veredicto sobre un commit concreto. Una
vez dado, no queda nada que revisar de ese commit. Sin esta regla, la revisión se
reintentaba hasta agotar sus intentos y quedaba bloqueada sin motivo.

---

## D38 · Codex se ejecuta fuera de su propio aislamiento en Windows

**Origen:** técnica, fase 2.

El adaptador de Codex lanza el motor con el aislamiento desactivado, salvo en el modo de
solo planificar.

**Por qué:** en Windows, el aislamiento propio de Codex rechaza el lanzamiento de
PowerShell, tanto en modo de solo lectura como en modo de escritura en el espacio de
trabajo. Con él activado, el agente no puede ejecutar nada: ni consultar el historial de
Git ni lanzar las pruebas. En la prueba real, el reviewer terminó diciendo que no había
podido revisar nada.

**Qué sigue protegido:** el worktree separado, las instrucciones del rol, y que ningún
agente hace push ni fusiona en la rama principal. Es el mismo razonamiento de la decisión
D26 aplicado al otro motor.

---

## D39 · Dos modos de trabajo, y el recorrido lo decide lo que se pide

**Origen:** creador, 7 de septiembre de 2026.

El proyecto tiene dos modos. En **normal**, el orquestador decide qué necesita revisión y
solo trabaja el rol que haga falta. En **estricto**, todo lo que deja un commit se revisa
y después pasa por el refactorer.

El modo se cambia desde la cabecera de la interfaz. Se graba en cada tarea al crearla, así
que cambiar de modo no altera el trabajo que ya está en marcha.

**Por qué:** el creador quiere poder pedirle al orquestador que investigue algo sin que
eso monte una cadena de construcción, revisión e integración. Obligar a recorrer todas las
etapas en cada petición es lo que le molesta del desarrollo dirigido por especificación.
El recorrido lo decide lo que se pide, no el sistema.

**Qué sustituye:** hasta ahora, cualquier tarea que dejaba un commit generaba una revisión
sin excepción, y no lo decidía nadie: estaba fijo en el código.

---

## D40 · Quién decide que algo se revisa, y el suelo que no puede saltarse

**Origen:** técnica, dentro de la decisión D39.

El orquestador marca cada tarea al crearla. Marca que no necesita revisión solo cuando el
cambio toca únicamente documentación, comentarios o textos, o cuando es código nuevo que
todavía no usa nada del proyecto. Ante la duda, marca que sí.

Por encima de su decisión hay un suelo que el sistema aplica siempre, y que revisa aunque
el orquestador dijera que no hacía falta:

- La verificación del proyecto no pasó, o no llegó a ejecutarse.
- El proyecto no tiene comando de verificación.
- El agente terminó a medias en lugar de completo.
- El agente necesitó algo fuera de su alcance.

**Por qué:** el suelo es lo que hace que equivocarse marcando una tarea no pueda dejar
pasar código roto. Se apoya en datos que el agente ya devuelve en su resultado, así que no
hace falta ningún campo nuevo en el contrato.

---

## D41 · Un rol nuevo: el refactorer

**Origen:** creador, 7 de septiembre de 2026.

Se añade un quinto rol. El refactorer mejora código que ya funciona sin cambiar lo que
hace: nombres, duplicación, funciones que mezclan responsabilidades, comentarios obsoletos
y código muerto.

Trabaja sobre un commit que el reviewer ya aprobó. Demuestra que no ha cambiado nada
ejecutando la verificación del proyecto antes y después. Si el proyecto no tiene comando
de verificación, no trabaja: sin forma de comprobarlo, cualquier cambio es una apuesta.

Solo entra en modo estricto. Una tarea de refactor no genera otra, para que la cadena no se
encadene sola.

**Qué sustituye:** el apartado 6.6 del documento 06 decía que la limpieza de código se
asigna como tarea al builder y que solo se crean roles nuevos cuando el volumen lo
justifique.

**Por qué:** al reviewer se le prohíbe expresamente proponer cambios de estilo, así que ese
trabajo hoy no lo recoge nadie.

**Qué se descartó:** un agente limpiador que borrara los restos del desarrollo con IA. Al
estudiar SwarmForge se vio que el problema se evita mejor con dos reglas de flujo, que ya
están en las instrucciones comunes: los ficheros temporales van dentro del directorio de
trabajo del agente, y no se comitea nada ajeno a la tarea. El código muerto y los intentos
abandonados los recoge el refactorer.

---

## D42 · Las instrucciones de los agentes viven en ficheros de texto

**Origen:** técnica, 7 de septiembre de 2026.

El texto que recibe cada agente está en la carpeta `instrucciones/`, no en el código. Se
compone de dos partes: las reglas comunes a todos los agentes, y las de su rol. Se leen del
disco en cada ejecución.

**Por qué:** cambiar lo que hace un agente pasa a ser editar un fichero de texto, y el
cambio se aplica a la tarea siguiente sin recompilar ni reiniciar. Antes, cada instrucción
era una cadena de TypeScript dentro de `src/core/roles.ts`.

**De dónde viene:** de la constitución de SwarmForge, el sistema de coordinación de agentes
de Robert C. Martin. Allí las reglas también son ficheros que cada agente lee antes de
empezar, separando la ley común de la de cada rol.

**Lo que sigue en el código:** las herramientas que puede usar cada rol. No son texto para
el agente sino permisos que se le dan al motor, y una instrucción es una petición mientras
que un permiso es una garantía.

---

## D43 · Una migración que recrea una tabla se ejecuta sin claves foráneas

**Origen:** técnica, 7 de septiembre de 2026.

Una migración puede declarar que necesita las claves foráneas desactivadas. El ejecutor las
apaga antes de abrir la transacción, aplica la migración, y comprueba con
`PRAGMA foreign_key_check` que no ha quedado ninguna referencia rota antes de darla por
buena.

**Por qué:** SQLite no permite modificar una restricción CHECK. Ampliar la lista de roles
válidos obliga a recrear las tablas `agents` y `tasks`, y recrear significa borrar. Con las
claves foráneas activadas, ese borrado arrastra en cascada las filas de todas las tablas
que apuntaban a ella, y lo hace **sin dar ningún error**. La primera versión de la
migración se llevó por delante todas las tareas del proyecto en silencio.

`PRAGMA foreign_keys` no hace nada dentro de una transacción, así que la desactivación
tiene que hacerla el ejecutor y no la propia migración.

---

## D44 · Una corrección es la misma tarea, en la misma rama

**Origen:** técnica, 9 de septiembre de 2026.

Cuando el reviewer abre un hallazgo blocker o major, la tarea revisada vuelve a `ready` con
los hallazgos en su encargo, con prioridad alta, y su siguiente intento continúa en su
misma rama y su mismo worktree. No se crea ninguna tarea de corrección aparte. Lo mismo
cuando la integración pasa la fusión pero falla las verificaciones: se abre un hallazgo
bloqueante sobre la tarea y vuelve a la cola.

En modo estricto, la tarea aprobada no pasa a `done` hasta que su limpieza termina. El
refactorer trabaja en el mismo worktree; cuando su incremento queda aprobado, la tarea
original queda hecha con el commit del refactor como commit final. Una revisión o una
limpieza no se integran nunca: se integra la tarea sobre la que trabajaron.

**Por qué:** hasta ahora un hallazgo bloqueante dejaba dos tareas para el mismo trabajo, la
original de vuelta en `ready` y una `fix` nueva, las dos sobre la misma rama y el mismo
directorio. Con un worker, el builder hacía la corrección y después volvía a ejecutar la
tarea original, que publicaba otro incremento y otra revisión. Con dos workers, dos agentes
escribían en el mismo directorio a la vez. Al integrar una, se borraba la rama que la otra
necesitaba. Y el refactor tenía el mismo problema: la tarea quedaba integrable mientras el
refactorer seguía escribiendo en su rama.

**Contra los bucles:** cada incremento rechazado cuenta. Cuando el número de incrementos
rechazados de una tarea llega a `max_task_attempts`, la tarea se bloquea con los últimos
hallazgos y el orquestador toma un turno.

**Sustituye a:** los apartados 7.4 y 7.5 del documento de flujo tal como estaban, y la
tarea de tipo `fix` generada por el sistema. El tipo `fix` sigue existiendo para que el
orquestador pueda crear una corrección a mano; se comporta como una construcción.

---

## D45 · Ningún agente trabaja en el directorio del creador

**Origen:** técnica, 9 de septiembre de 2026.

Toda ejecución de un motor ocurre en un worktree. Las tareas que escriben código ya lo
tenían. La revisión trabaja en el worktree de la tarea que revisa, que está parada mientras
tanto, y lo que deje escrito se descarta al terminar. La investigación trabaja en un
worktree sin rama sobre la rama principal, que se elimina al terminar. El orquestador es el
único que mira el repositorio del creador, y solo tiene herramientas de lectura.

La integración exige que el repositorio del creador esté en la rama principal, sin cambios
sin confirmar, y que la punta de la rama de la tarea sea exactamente el commit aprobado. Si
no, se niega y dice por qué, sin cambiar nada.

**Por qué:** el reviewer y el investigador se lanzaban en la carpeta de trabajo del creador
con Bash y sin pedir permiso. «No modifiques ficheros» era una instrucción, no una
garantía. Y la integración hacía checkout, merge y `reset --hard` en esa misma carpeta sin
mirar si el creador tenía algo a medias: deshacer una fusión fallida le habría borrado sus
cambios sin confirmar.

**Coste aceptado:** un worktree más por investigación, con su instalación de dependencias.

---

## D46 · Las preguntas de los agentes llegan al orquestador, y el orquestador contesta con notas

**Origen:** técnica, 9 de septiembre de 2026.

El campo `questions` del resultado de un agente se convierte en mensajes dirigidos al
orquestador y en un mensaje del agente en el chat. Una pregunta o una tarea bloqueada
piden un turno del orquestador sin esperar al siguiente mensaje del creador. El plan del
orquestador gana dos campos: `notes`, indicaciones que una tarea recibe en su siguiente
ejecución, y `reopen`, tareas bloqueadas que vuelven a la cola con el motivo. El creador
puede reabrir una tarea bloqueada desde la web.

**Por qué:** el campo `questions` se guardaba y nadie lo leía. Una tarea bloqueada por una
pregunta se quedaba bloqueada hasta que el creador la encontrara por su cuenta. Y la
mensajería entre agentes de la fase 2 solo la llamaban las pruebas: ningún agente tenía
forma de enviar un mensaje. Ahora el único canal real entre agentes son las peticiones de
apoyo del campo `needs` y las preguntas al orquestador. El escalado al sexto mensaje de la
decisión D33 sigue en el código, pero no hay hoy ninguna conversación que pueda llegar a
seis mensajes.

---

## D47 · El adaptador de Claude Code sigue a la versión instalada, no a la documentación

**Origen:** técnica, 9 de septiembre de 2026, tras la tercera ejecución real.

El adaptador pasa solo las opciones que Claude Code 2.1.153 acepta: sin `--permission-prompts`
ni `--safe-mode`, con el modo de permisos `default` para el orquestador, y leyendo el
resultado estructurado del campo `structured_output`. El esquema que recibe Claude no exige
las propiedades que admiten null; el que recibe Codex sigue exigiéndolas todas (decisión D35).
Cada ejecución guarda el identificador del proceso del motor, y el arranque mata los que
quedaron vivos de una sesión anterior.

**Por qué:** con las opciones anteriores el motor terminaba antes de empezar, y el sistema
entero llevaba sin poder ejecutar un agente desde la actualización del motor. Nadie lo
había visto porque las pruebas automáticas no lanzan el motor real. Y Claude omite los
campos nulos: con el esquema estricto rechazaba el plan del orquestador hasta agotar los
intentos.

**Consecuencia:** la fase 0 (decisión D20) hay que repetirla cada vez que se actualiza el
motor. Queda como comprobación de arranque pendiente: lanzar un encargo mínimo al motor y
parar si falla, en vez de descubrirlo en la primera tarea del creador.

---

## Decisiones aún abiertas

| Tema | Cuándo se decide |
| --- | --- |
| Estilo visual concreto: colores, tipografía e identidad. | Al empezar la tarea de diseño de la interfaz, en la fase 1. |
| Forma exacta del adaptador de Codex. | Al empezar la fase 2, con la documentación vigente en esa fecha. |
| Si el sistema pasa a un servidor siempre encendido. | Cuando el uso real demuestre que hace falta. |

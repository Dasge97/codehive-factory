# 13 · Plan hacia un sistema de confianza

Escrito el 9 de septiembre de 2026, después de la tercera ejecución real. Este documento
dice qué significa que Code Hive Factory sea un sistema en el que el creador pueda confiar,
en qué punto está hoy, qué le falta, y en qué orden se hace. Es la referencia de la fase 3
en adelante. El documento 09 sigue siendo el plan de las fases 0 a 2.

## 13.1 De dónde viene y en qué se distingue

La inspiración es SwarmForge, el sistema de coordinación de agentes de Robert C. Martin.
Conviene tener claro qué se ha tomado de allí y qué no, porque decide qué se copia y qué no.

| | SwarmForge | Code Hive Factory |
| --- | --- | --- |
| Unidad de trabajo | Un paquete que pasa de rol en rol por un tubo fijo (specifier, coder, refactorer, architect). | Una tarea con estado propio. El recorrido lo decide lo que se pide (decisión D39). |
| Aislamiento | Un worktree por rol. | Un worktree por tarea. Dos builders trabajan a la vez sin pisarse. |
| Coordinación | Entregas entre agentes por ficheros y un demonio de mensajes; los agentes viven en paneles de tmux. | Código determinista sobre SQLite: cola, reclamación atómica, vigencias, hallazgos, integración (decisión D17). |
| Reglas | Una constitución en ficheros: ingeniería, flujo, entregas. Cada rol añade su prompt. | Lo mismo, copiado a propósito (decisión D42), pero con menos contenido. |
| Control del creador | Panel con aprobaciones, aclaraciones y vista de cada panel. | Web con chat, tareas, hallazgos, integración y preguntas. Sin vista del registro completo de una ejecución. |
| Motores | Claude, Codex, Grok y Copilot. | Claude Code y Codex; hoy solo Claude en la máquina del creador. |
| Garantía sobre la rama principal | La da el operador al aceptar la entrega final. | La da el sistema: verificación ejecutada por él mismo tras fusionar, y el botón del creador. |

**Lo que se conserva de SwarmForge:** la constitución en ficheros, la disciplina de commits
limpios, un rol de limpieza separado del que construye, y un operador humano que resuelve
aclaraciones y aprobaciones.

**Lo que se hace distinto a propósito:** tareas con estado en vez de un tubo fijo, un
worktree por tarea en vez de por rol, y coordinación por código en vez de por mensajes
entre agentes. Estas tres cosas son las que han hecho que la tercera ejecución real
aguante fallos provocados, y no se cambian.

**Lo que SwarmForge tiene y aquí falta:** una constitución de ingeniería con contenido
(estándares, pruebas, tamaño de los cambios), etapas de especificación y de arquitectura
para peticiones grandes, y una vista del trabajo de cada agente en vivo con su registro
entero.

## 13.2 Qué significa «sistema de confianza»

Se puede afirmar cuando se cumplen estas ocho condiciones. Cada una tiene una forma de
comprobarla que no depende de la opinión de nadie.

| # | Condición | Cómo se comprueba |
| --- | --- | --- |
| C1 | El sistema no arranca si no puede ejecutar un agente de verdad. | Al arrancar lanza un encargo mínimo al motor real y para con un mensaje claro si falla. |
| C2 | Nada llega a la rama principal sin verificación ejecutada por el sistema y sin el botón del creador. | Ya se cumple. Prueba automática y prueba real del documento 10. |
| C3 | Ningún agente puede tocar el repositorio del creador ni sus cambios sin confirmar. | Ya se cumple (decisión D45). |
| C4 | Cada ejecución se puede leer entera después: qué hizo el agente, qué ejecutó, qué costó. | Desde la web se abre el registro completo de cualquier ejecución, y el coste por tarea y por día. |
| C5 | Un fallo del motor, de la cuota o de la máquina deja el estado coherente y visible. | Pruebas reales de: cuota agotada, motor caído, disco, reinicio. Cada una con su fila en el documento 10. |
| C6 | Las reglas de ingeniería están escritas y los agentes las cumplen o dicen por qué no. | Constitución con contenido, y el reviewer la usa como lista de comprobación. |
| C7 | Ha trabajado dos semanas sobre un proyecto real del creador con un registro de incidencias, y la última semana no tiene ninguna incidencia grave. | Documento 14, diario de uso. |
| C8 | Otra persona puede arrancarlo en otra máquina siguiendo la guía, sin ayuda. | Guía de arranque probada por alguien que no sea el creador. |

Hoy se cumplen C1, C2 y C3. Las demás son el trabajo de este plan.

## 13.3 Fases

Cada fase tiene tareas numeradas y una condición de cierre. Las fases van en orden. No
se empieza la siguiente sin cerrar la anterior, porque cada una se apoya en la anterior.

### Fase 3 · Fiabilidad ante lo que el sistema no controla

Cierra las condiciones C1 y C5.

| Tarea | Qué se hace | Hecho cuando |
| --- | --- | --- |
| F3-01 | Comprobación de arranque contra el motor real: un encargo mínimo con esquema, con tiempo máximo corto. Si falla, el sistema no arranca y dice el motivo y la versión del motor. | **Hecha el 9 de septiembre de 2026.** Cada motor recibe un encargo de prueba al arrancar; un motor que responde a `--version` pero no pasa el encargo deja el sistema sin arrancar, con el motivo. Comprobado con el motor real y con uno que falla a propósito. |
| F3-02 | Cuota real: averiguar qué publica Claude Code 2.1 sobre los límites de la suscripción, porque el campo de utilización llega vacío. Si el motor ya no lo publica, la web lo dice en vez de enseñar un hueco. | La cabecera muestra la cuota o dice que el motor no la informa. |
| F3-03 | Cuota agotada de verdad: provocarla o simularla con el motor real, comprobar que las tareas quedan bloqueadas con motivo y que se reanudan al volver. | Fila nueva en el documento 10. |
| F3-04 | Motor caído: matar el proceso del motor a mitad, con el sistema en marcha. Comprobar el resultado de la ejecución, el estado de la tarea y el reintento. | Fila nueva en el documento 10. |
| F3-05 | Un worktree que ya no está donde debería: borrar a mano el worktree de una tarea en curso y ver que el sistema lo recrea o bloquea la tarea con motivo, sin romperse. | Fila nueva en el documento 10. |
| F3-06 | Copia de seguridad de la base de datos: copia diaria del fichero SQLite con rotación, y un comando para restaurar. | Se restaura una copia y el sistema arranca con ella. |
| F3-07 | Parada limpia siempre: cerrar la ventana, Ctrl+C, apagar el equipo. Cada caso deja las ejecuciones marcadas y los procesos del motor muertos. | Tres pruebas reales, sin procesos huérfanos. |

### Fase 4 · Ver todo lo que pasa

Cierra la condición C4.

| Tarea | Qué se hace | Hecho cuando |
| --- | --- | --- |
| F4-01 | Registro completo de cada ejecución: guardar el flujo entero del motor (mensajes, herramientas, resultados) en un fichero por ejecución, fuera de la base de datos. | Cualquier ejecución de la semana pasada se puede leer entera. |
| F4-02 | Vista del registro en la web: desde el detalle de una tarea se abre el registro de cada ejecución, en vivo mientras corre. Es lo que SwarmForge da con los paneles de tmux. | Se sigue una ejecución en marcha desde el móvil. |
| F4-03 | Coste por tarea, por día y por proyecto, con lo que informa el motor. Y aviso en la cabecera cuando el gasto del día pasa un tope configurable. | La web enseña cuánto ha costado cada tarea y el total del día. |
| F4-04 | Informe de cierre de cada tarea integrada: qué se pidió, qué se hizo, qué encontró el reviewer, cuántos intentos, cuánto costó. En un texto corto que el creador lee en un minuto. | Aparece al integrar. |

### Fase 5 · La constitución

Cierra la condición C6. Es la parte que más se aprovecha de SwarmForge.

| Tarea | Qué se hace | Hecho cuando |
| --- | --- | --- |
| F5-01 | Artículo de ingeniería en `instrucciones/comunes/`: pruebas primero cuando el proyecto lo permita, tamaño máximo de un cambio, nombres, tratamiento de errores, dependencias nuevas solo con permiso del creador. | El fichero existe y cabe en una página. |
| F5-02 | Reglas por lenguaje, en ficheros aparte que se cargan según el proyecto: JavaScript y TypeScript primero, después lo que haga falta. | Un proyecto de Node recibe sus reglas; uno de Python no las recibe. |
| F5-03 | El reviewer usa la constitución como lista de comprobación: cada regla incumplida es un hallazgo con la regla citada. | Un cambio que incumple una regla escrita recibe un hallazgo que la cita. |
| F5-04 | Etapa de especificación para peticiones grandes: el orquestador crea primero una tarea de investigación que produce criterios de aceptación concretos, y solo después las tareas de construcción, que dependen de ella. Es el specifier de SwarmForge, sin rol nuevo. | Una petición de más de un fichero pasa antes por una especificación que el creador puede leer. |
| F5-05 | Reglas de la constitución por proyecto: un fichero en el repositorio gestionado que añade o anula reglas, y que el creador edita como cualquier otro fichero. | Un proyecto puede decir «aquí no se exigen pruebas». |

### Fase 6 · Uso real

Cierra la condición C7. No tiene tareas de código: tiene un método.

1. Se elige un proyecto real del creador, con pruebas y en uso.
2. Durante dos semanas todo el trabajo de ese proyecto entra por Code Hive Factory.
3. Cada incidencia se apunta en el documento 14 con la fecha, qué pasó, qué hizo el
   sistema, qué tuvo que hacer el creador, y qué se cambia.
4. Cada cambio en el sistema que salga del diario entra por el propio sistema, como en la
   decisión D07.
5. Al final, el diario dice cuántas tareas, cuántas integradas sin tocar nada, cuántas con
   intervención, cuánto costó, y qué queda.

La condición C7 se cumple si la segunda semana no tiene ninguna incidencia grave. Grave es:
algo llegó a la rama principal sin pasar por revisión, el sistema perdió trabajo, o el
creador tuvo que tocar la base de datos a mano.

### Fase 7 · Otra máquina y otro motor

Cierra la condición C8, y recupera la revisión con un segundo motor.

| Tarea | Qué se hace | Hecho cuando |
| --- | --- | --- |
| F7-01 | Guía de arranque completa: requisitos, instalación, primer proyecto, qué hacer cuando algo falla. Probada por alguien que no sea el creador, en una máquina limpia. | Esa persona llega a integrar una tarea sin preguntar nada. |
| F7-02 | Arranque como servicio de Windows, con reinicio automático y registro en fichero. | Sobrevive a un reinicio del equipo sin tocar nada. |
| F7-03 | Codex en una máquina donde el Codex instalado sea compatible con la cuenta: volver a validar el adaptador contra la versión real, como se hizo hoy con Claude. | El reviewer revisa con Codex un incremento de Claude, y viceversa, en la tercera ejecución real repetida. |
| F7-04 | Un proyecto que no es de Node: comprobación de que el comando de verificación, el de instalación y las reglas por lenguaje funcionan con Python o con otro. | Fila nueva en el documento 10. |

## 13.4 Lo que no entra en este plan

- Convertirlo en un producto para terceros. Sigue fuera de alcance (documento 01).
- Más roles. El architect y el tester de SwarmForge no entran hasta que el diario de la
  fase 6 diga que hacen falta. Cada rol nuevo es más cuota y más cadena.
- Acceso desde fuera de la red local.
- Integración automática sin el creador. La condición C2 lo prohíbe a propósito.

## 13.5 Orden y ritmo

Las fases 3, 4 y 5 son trabajo de código y se pueden hacer por el propio sistema, como se
hizo con la fase 2 (decisión D07). La fase 6 es calendario: dos semanas. La fase 7 depende
de tener otra máquina y otra persona.

Lo primero, antes que cualquier otra cosa, es F3-01. Hoy el sistema llevaba días sin poder
ejecutar un agente y nadie lo sabía.

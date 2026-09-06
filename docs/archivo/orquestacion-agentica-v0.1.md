> **Documento archivado.** Es el borrador de partida del 6 de septiembre de 2026.
> No es la referencia vigente. La documentación en vigor está en la carpeta `docs/`,
> empezando por el README del repositorio.

# Code Hive Factory

Sistema de orquestación agéntica · Documento de definición · Versión 0.3 · 6 de septiembre de 2026

Estado: borrador de trabajo para seguir diseñando el sistema con su creador.

## 1. Visión

Construir un sistema de desarrollo en el que el creador conversa con un agente orquestador, explica qué quiere conseguir y puede seguir interviniendo mientras un equipo de agentes desarrolla el proyecto. El orquestador traduce esa intención en trabajo concreto, coordina las dependencias y mantiene una visión actualizada del conjunto.

El trabajo avanza de forma concurrente y continua. Un agente puede implementar una funcionalidad mientras otro revisa un incremento anterior y otro investiga una decisión independiente. Cuando aparece un problema, la corrección entra en el trabajo activo sin esperar a que termine una ronda global.

Se busca una complejidad asumible para los proyectos del creador. La referencia a Karpathy y al SDD clásico expresa esa intención; este documento no presupone una implementación concreta de ninguno de ellos.

La sensación que debe ofrecer el producto es: «Estoy hablando con quien coordina mi equipo y el equipo está avanzando; puedo ver qué ocurre y cambiar el rumbo cuando lo necesite».

## 2. Base confirmada con el creador

Estos puntos proceden del resumen disponible de la conversación anterior:

| ID | Requisito acordado |
| --- | --- |
| A01 | El creador se comunica con un agente orquestador que reparte tareas específicas. |
| A02 | Los agentes pueden trabajar simultáneamente cuando sus tareas lo permiten. |
| A03 | El sistema evita un ciclo global rígido en el que todos esperan al agente de turno. |
| A04 | El builder puede atender una corrección detectada por el reviewer sin esperar a otra fase del proyecto. |
| A05 | El sistema dispone de colas de trabajo y workers por agente. |
| A06 | Los agentes conocen la existencia de los demás y pueden ayudarse entre ellos. |
| A07 | La solución debe mantener una complejidad intermedia y práctica para la escala del creador. |
| A08 | Los motores iniciales serán Claude Code y Codex; se prioriza utilizarlos con las suscripciones del creador. |
| A09 | El creador quiere diseñar la interfaz visual de su propio sistema. |
| A10 | La interfaz será una web muy visual. |

A08, A09 y A10 se han concretado en esta conversación de documentación. El nombre Code Hive Factory procede del contexto disponible de la conversación de nombres. La compatibilidad efectiva de cada modalidad de suscripción se verificará por proveedor; A08 expresa el requisito del creador, no una garantía de acceso ilimitado.

Los apartados siguientes son propuestas de diseño para concretar estos requisitos. No representan decisiones ya aprobadas sobre tecnologías, proveedores, número de agentes o despliegue.

## 3. Conceptos del sistema

| Concepto | Significado propuesto |
| --- | --- |
| Proyecto | Objetivo compartido, contexto, decisiones, código y trabajo asociado. |
| Orquestador | Agente que interpreta la intención del creador y coordina alcance, prioridades y bloqueos. |
| Rol | Responsabilidad y capacidades esperadas: construir, revisar, investigar, etc. |
| Agente | Identidad configurada con un rol, herramientas, instrucciones y acceso al contexto. |
| Worker | Instancia de ejecución que toma un encargo y trabaja en él. Un agente puede tener varios workers si se habilita esa capacidad. |
| Tarea | Unidad de trabajo con objetivo, alcance, dependencias y condiciones de aceptación. |
| Ejecución | Intento concreto de un worker sobre una tarea; registra versión de entrada, resultado y consumo. |
| Cola | Trabajo disponible para un agente o capacidad, ordenado por prioridad y dependencias. |
| Evento | Hecho registrado: resultado publicado, problema detectado, tarea bloqueada o decisión modificada. |
| Incremento | Resultado parcial identificable que ya puede inspeccionarse, revisarse o utilizarse. |

Separar rol, agente y worker permite empezar con pocos ejecutores y ampliar capacidad sin convertir cada responsabilidad en un servicio independiente.

## 4. Equipo inicial propuesto

La primera versión puede cubrir cuatro responsabilidades. No es obligatorio mantener cuatro procesos de IA ejecutándose permanentemente.

| Responsabilidad | Trabajo principal | Resultado esperado |
| --- | --- | --- |
| Orquestación | Entender la petición, dividir trabajo, coordinar prioridades y resolver contradicciones. | Plan vivo, tareas concretas y explicación del estado al creador. |
| Construcción — builder | Implementar incrementos y corregir hallazgos. | Cambios identificables y explicación de cómo verificarlos. |
| Revisión — reviewer | Revisar resultados disponibles, contrastarlos con los requisitos y comunicar problemas. | Hallazgos accionables o conformidad sobre una versión específica. |
| Investigación y apoyo | Resolver incógnitas, inspeccionar el proyecto y apoyar tareas concretas. | Evidencia o propuesta que desbloquee una decisión o implementación. |

Pruebas, documentación y limpieza de código pueden asignarse como capacidades dentro de este equipo. Crear roles dedicados quedaría para cuando exista suficiente trabajo que lo justifique.

El orquestador decide sobre el conjunto, pero no tiene que reenviar personalmente cada mensaje. Las consultas operativas entre agentes pueden resolverse directamente y quedar registradas para que conserve visibilidad.

## 5. Funcionamiento continuo

### 5.1 De la conversación a trabajo ejecutable

El orquestador convierte la petición en una descripción breve del resultado deseado, restricciones y criterios de aceptación. Identifica qué puede empezar ya y qué depende de una aclaración o de otro resultado.

La planificación se actualiza durante la ejecución. No se exige cerrar toda la especificación antes de iniciar tareas suficientemente claras. Las dudas bloquean únicamente el trabajo afectado.

Cuando el creador cambia un requisito, el sistema registra una nueva revisión de la decisión, identifica tareas y resultados afectados y conserva el trabajo compatible. Los resultados que respondan a instrucciones anteriores se marcan para reevaluación.

### 5.2 Colas y asignación

Se propone un registro central de tareas con vistas de cola por agente o capacidad. Así pueden existir colas especializadas sin duplicar una misma tarea en varias fuentes de verdad.

Una tarea solo se puede reclamar cuando sus dependencias están satisfechas, existe capacidad disponible y su alcance no entra en conflicto con otro trabajo activo. La reclamación debe ser atómica: dos workers no pueden convertirse simultáneamente en responsables de la misma tarea.

Un worker ocupado recibe los avisos relevantes y puede reorganizar su trabajo en un punto seguro. Si existe otro worker disponible y la corrección es independiente, puede asumirla. «Sin esperar al siguiente ciclo» no significa interrumpir arbitrariamente cualquier comando ni prometer ejecución instantánea con recursos ilimitados.

Las correcciones que desbloquean trabajo reciben prioridad. También debe evitarse que una sucesión de correcciones menores deje indefinidamente sin atención tareas antiguas.

### 5.3 Revisión y corrección

El builder publica incrementos coherentes y versionados. El reviewer puede revisarlos mientras la construcción continúa en otras tareas. No se revisan archivos a medio escribir como si fueran una entrega estable.

Un hallazgo incluye la versión revisada, el problema, su impacto, evidencia y una condición para considerarlo resuelto. El hallazgo genera una corrección vinculada al trabajo original y avisa al responsable.

La corrección produce una nueva versión que se vuelve a revisar donde corresponda. La aprobación de una versión anterior no se traslada automáticamente a cambios posteriores.

Una tarea puede tener partes revisadas mientras sigue en ejecución. La integración del incremento sí exige cumplir sus condiciones de aceptación y resolver los hallazgos que la bloquean. El resto del proyecto puede seguir avanzando.

## 6. Colaboración entre agentes

### 6.1 Conocimiento del equipo

Cada agente puede consultar un directorio con los roles disponibles, sus capacidades, tareas activas y disponibilidad. La conciencia del equipo se materializa mediante contexto accesible y actualizado.

Cada encargo incluye el objetivo del proyecto, las decisiones relevantes, su propio alcance y las relaciones con otros trabajos. No necesita copiar todo el historial de todos los agentes.

### 6.2 Formas de ayuda

| Interacción | Ejemplo | Regla propuesta |
| --- | --- | --- |
| Consulta | El builder pregunta al investigador cómo funciona una parte del proyecto. | Respuesta vinculada a la tarea y a la evidencia utilizada. |
| Aviso | El reviewer detecta que una decisión afecta a otra funcionalidad. | Notificar a los responsables afectados. |
| Petición de apoyo | El builder solicita una inspección acotada de una dependencia. | Si requiere ejecución propia, crear una subtarea con responsable. |
| Oferta de ayuda | Un agente libre identifica un bloqueo que sabe resolver. | Reclamar o recibir trabajo mediante el registro compartido. |
| Escalado | Dos agentes proponen cambios incompatibles. | El orquestador resuelve la prioridad o lleva al creador la decisión de producto. |

Ayudarse no concede permiso para modificar el trabajo ajeno sin coordinación. Cada tarea mantiene un responsable y cada cambio identifica su autor y su versión de origen.

Las conversaciones entre agentes deben producir una respuesta, una decisión, un hallazgo o una tarea. Se proponen límites de intercambios y escalado cuando no haya progreso para evitar bucles de conversación.

## 7. Estado y trazabilidad del trabajo

### 7.1 Información mínima de una tarea

- Identificador, proyecto y objetivo.
- Alcance y criterios de aceptación.
- Prioridad, capacidad requerida y dependencias.
- Estado, responsable y ejecución activa, si existe.
- Revisión de requisitos y versión de código o documento de partida.
- Recursos compartidos afectados.
- Resultados, verificaciones y hallazgos relacionados.
- Motivo del bloqueo o cancelación, cuando corresponda.

### 7.2 Estados propuestos

| Estado | Significado |
| --- | --- |
| Pendiente | Registrada, todavía sin todos los requisitos para ejecutarse. |
| Lista | Puede ser reclamada por un worker compatible. |
| En curso | Tiene una ejecución activa. |
| En revisión | El resultado está disponible y espera validación. |
| Bloqueada | Necesita una decisión, dependencia o recurso identificado. |
| Completada | Cumple los criterios y las verificaciones requeridas. |
| Cancelada | Ha dejado de formar parte del trabajo solicitado. |

Estas transiciones pertenecen a cada tarea, no al equipo entero. Una tarea en revisión puede volver a estar lista para corregirse mientras otras siguen en curso. Los incrementos parciales pueden generar revisiones vinculadas sin cambiar el estado de toda la tarea principal.

### 7.3 Recuperación

El registro de tareas, decisiones y resultados debe persistir aunque termine una sesión del modelo. La memoria de una conversación no será la única fuente del estado del proyecto.

Las asignaciones tendrán una vigencia renovable para detectar workers caídos. Antes de reasignar una tarea se comprobarán sus resultados y posibles efectos ya ejecutados. Un resultado tardío de una ejecución sustituida no podrá sobrescribir automáticamente el estado vigente.

Los eventos duplicados no deben crear correcciones o integraciones repetidas. Los reintentos tendrán límites y conservarán la causa del fallo.

## 8. Trabajo concurrente sobre código

Se propone usar espacios de trabajo aislados por tarea o worker y resultados identificados por commit cuando el proyecto esté en Git. La herramienta concreta queda pendiente.

Los trabajos independientes pueden ejecutarse simultáneamente. Si dos tareas necesitan cambiar una interfaz compartida, se acuerda primero el contrato o se ordena únicamente esa modificación conflictiva. No hace falta detener el proyecto entero.

La integración es una responsabilidad explícita, inicialmente coordinada por el orquestador y ejecutada mediante herramientas. El procedimiento debe comprobar que el resultado sigue siendo compatible con la versión actual y realizar las verificaciones relevantes después de combinar los cambios.

Una revisión sobre una rama aislada no garantiza por sí sola que la integración final funcione. Si la combinación introduce un conflicto o cambia el comportamiento revisado, debe abrirse la corrección o revisión correspondiente.

## 9. Autonomía, límites y visibilidad

Se propone que los agentes puedan consultar contexto, crear tareas auxiliares acotadas, implementar, revisar y corregir dentro del alcance autorizado sin consultar cada paso al creador.

El creador interviene cuando hace falta una decisión de producto, resolver requisitos contradictorios o ampliar el alcance. Los permisos sobre publicación, despliegue, datos y servicios externos se configurarán según el entorno elegido y las instrucciones del creador.

La concurrencia y el consumo deben tener límites configurables por proyecto. No se iniciarán agentes continuamente para buscar actividad artificial; los workers se activan cuando existe trabajo útil. Si aumenta la cola de revisión, el sistema puede reducir nuevas construcciones y dedicar capacidad a resolver lo acumulado.

El creador debe poder saber:

- Qué está haciendo cada agente y con qué objetivo.
- Qué resultados ya puede revisar o utilizar.
- Qué está bloqueado, por qué y quién puede desbloquearlo.
- Qué correcciones siguen abiertas y qué afectan.
- Qué decisión necesita su intervención.
- Cuánto tiempo y consumo está requiriendo el trabajo, cuando esos datos estén disponibles.

La presentación será una web propia muy visual. Queda pendiente decidir dónde se alojará y dónde se ejecutarán los motores.

## 10. Escenario de referencia

Ejemplo ilustrativo: el creador pide añadir un área de proyectos a una aplicación existente.

1. El orquestador concreta el resultado y separa inspección del proyecto, estructura de datos e interfaz.
2. Un agente inspecciona convenciones existentes mientras un builder desarrolla un incremento con las decisiones ya claras. El trabajo dependiente de incógnitas concretas queda identificado.
3. El builder publica el primer incremento y continúa una tarea independiente.
4. El reviewer revisa ese incremento y detecta un fallo en la validación de nombres.
5. El hallazgo crea una corrección y avisa al builder. Un worker disponible la toma si el alcance permite aislarla; en caso contrario, el responsable la atiende en el siguiente punto seguro.
6. El investigador comunica una restricción del proyecto que afecta a la interfaz. Los agentes implicados ajustan sus tareas con esa información.
7. El reviewer valida la corrección sobre su nueva versión. Se integra el incremento tras las comprobaciones relevantes.
8. El creador pide añadir un filtro. El orquestador actualiza alcance y dependencias; el trabajo compatible continúa.

El escenario debe demostrar concurrencia real, colaboración útil y retorno inmediato del feedback al trabajo pendiente, con trazabilidad de cada cambio.

## 11. MVP propuesto y criterios de aceptación

Para contener la complejidad, se propone empezar con un creador, un proyecto activo, pocos roles y un límite reducido de workers configurable. Esto es una propuesta, no una restricción acordada para el producto final.

El MVP debe incluir conversación con el orquestador, tareas persistentes, colas, ejecución concurrente, mensajes entre agentes, revisión de incrementos, correcciones vinculadas y consulta del estado. El entorno de ejecución, los modelos y la interfaz se elegirán antes de implementar.

| Prueba de aceptación | Evidencia esperada |
| --- | --- |
| Dos tareas independientes avanzan a la vez. | Ejecuciones solapadas y resultados separados. |
| Un hallazgo entra en corrección mientras sigue otro trabajo. | Hallazgo, tarea vinculada y avance de una tercera tarea sin barrera global. |
| Un agente pide ayuda a otro. | Solicitud, respuesta o subtarea y aplicación del resultado. |
| Dos workers intentan reclamar la misma tarea. | Solo uno conserva una asignación válida. |
| Se pierde un worker durante el trabajo. | Detección, recuperación y control de resultados tardíos. |
| El creador modifica un requisito. | Tareas afectadas reevaluadas y trabajo compatible conservado. |
| Dos cambios coinciden en una parte compartida. | Conflicto gestionado y verificación de la integración. |
| Una corrección entra en bucle. | Límite de reintentos y escalado con evidencia. |

La validación debe medir trabajo terminado y correcto, bloqueos y coste de coordinación. Mantener todos los agentes ocupados no es por sí solo una medida de éxito.

## 12. Decisiones pendientes

| Orden | Decisión | Por qué importa |
| --- | --- | --- |
| 1 | Adaptadores concretos de Claude Code y Codex, con prioridad al acceso por suscripción ya elegido. | Verificar autenticación, sesiones, eventos y consumo en cada motor. |
| 2 | Dónde vivirá el sistema: equipo local, servidor o ambos. | Determina acceso a proyectos, persistencia y gestión de procesos. |
| 3 | Diseño y alojamiento de la web visual ya elegida. | Define cómo se mostrarán conversación, decisiones y actividad. |
| 4 | Qué tareas puede ejecutar e integrar de forma autónoma. | Define permisos y cuándo requiere intervención. |
| 5 | Equipo y capacidad inicial. | Ajusta roles y número de workers a la carga real. |
| 6 | Primer proyecto o cambio con el que se probará. | Permite evaluar el sistema con un caso concreto. |
| 7 | Repositorio para Code Hive Factory. | Da un destino estable a documentación e implementación cuando se solicite. |

## 13. Continuidad de la documentación

Este documento es el punto de partida. Cada decisión nueva debe marcarse como acordada e incorporarse con su motivo. Las alternativas descartadas se conservarán cuando expliquen una restricción importante.

Tras resolver el entorno de ejecución, la documentación puede ampliarse con arquitectura técnica, modelo de datos, contrato de tareas y mensajes, instrucciones por rol y plan de implementación del MVP.

Para un futuro agente implementador: utilizar la sección 2 como requisitos confirmados; tratar el resto como propuesta salvo aprobación posterior explícita. No convertir las decisiones pendientes en hechos ni comenzar el desarrollo solo por recibir este documento.

## 14. Interfaz propia sobre Claude Code y Codex

### 14.1 Dirección acordada

Code Hive Factory tendrá su propia presentación y coordinación del trabajo, utilizando inicialmente Claude Code y Codex como motores de ejecución. El objetivo es aprovechar las suscripciones del creador. El acceso directo mediante APIs de modelos queda como posible ampliación, sin ser un requisito del MVP.

### 14.2 Arquitectura propuesta

| Componente | Responsabilidad propia |
| --- | --- |
| Interfaz | Conversación con el orquestador, tareas, agentes, resultados y acciones del creador. |
| Servicio de coordinación | Persistencia, colas, prioridades, dependencias, asignaciones y registro de eventos. |
| Adaptador de motor | Traducir encargos y eventos entre el contrato de Code Hive Factory y cada herramienta. |
| Motor Claude o Codex | Ejecutar las sesiones de programación con sus herramientas y autenticación admitida. |
| Espacios de proyecto | Código, ramas, resultados y verificaciones de cada trabajo. |

El orquestador de IA también puede ejecutarse mediante uno de estos motores. El servicio de coordinación mantiene el estado y ejecuta las reglas de asignación; no necesita una llamada a un modelo para cada transición o actualización visual.

Como propuesta, el proveedor se configura por agente: por ejemplo, construcción con Claude y revisión con Codex. Estos ejemplos no fijan una distribución obligatoria. El estado común permite colaborar a agentes de diferentes motores.

### 14.3 Vías documentadas, consultadas el 6 de septiembre de 2026

**Codex.** App Server está diseñado para integrar Codex en clientes propios y expone autenticación, historial, aprobaciones y eventos progresivos. Incluye autenticación ChatGPT gestionada por Codex y consulta de límites. Es el candidato propuesto para nuestra interfaz. [Documentación de App Server](https://learn.chatgpt.com/docs/app-server). El acceso mediante ChatGPT utiliza la suscripción; la clave API corresponde a otra modalidad de consumo. [Autenticación](https://learn.chatgpt.com/docs/auth).

**Claude.** La CLI permite ejecución programática y salida JSON o stream-json. El modo bare no utiliza el login de suscripción y la documentación anuncia que será el predeterminado de las llamadas con -p en una versión futura; habrá que validar la versión elegida. [Ejecución programática](https://code.claude.com/docs/en/headless).

El centro de ayuda indica que el cambio de facturación anunciado para el 15 de junio fue pausado: Agent SDK, claude -p y aplicaciones de terceros continúan consumiendo los límites de la suscripción por ahora. No se debe interpretar el contenido histórico que aparece debajo de ese aviso como el régimen vigente. [Uso del SDK con el plan Claude](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

La guía del Agent SDK mantiene una restricción sobre ofrecer login claude.ai o límites de suscripción en productos de terceros sin aprobación previa. La información de consumo no resuelve por sí sola esa restricción. Se debe distinguir el uso personal del creador de una futura distribución del producto. [Guía del Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).

Estas comprobaciones documentales no equivalen a una prueba funcional con la cuenta del creador. No se ha ejecutado ni autenticado ningún motor durante esta fase.

### 14.4 Control visual

La interfaz representará los eventos estructurados del motor y los del coordinador con componentes propios. Se propone mostrar conversación principal, agentes activos, colas, bloqueos, hallazgos y cambios de código. Los detalles extensos podrán desplegarse dentro de cada tarea.

El alcance visual estará limitado por los datos que cada motor publique: no se promete acceso a razonamientos internos, porcentajes de progreso inventados ni métricas que el proveedor no exponga. Si una capacidad no existe en un adaptador, la interfaz lo reflejará.

Las peticiones de autorización y los errores que requieran intervención seguirán visibles aunque se simplifique la presentación. Las credenciales permanecerán gestionadas por el motor y el entorno de ejecución; la interfaz no necesita recibir los tokens de la cuenta.

### 14.5 Primera prueba técnica propuesta

Antes de construir toda la interfaz, validar para cada motor: inicio de sesión con la cuenta del creador, envío de un encargo, recepción de eventos estructurados, continuidad de sesión, respuesta a una petición de autorización, interrupción admitida y identificación de límites o fallos de autenticación. Verificar además dos tareas independientes concurrentes en espacios aislados.

Registrar qué capacidades funcionan con la versión probada y qué modalidad de consumo está activa. La falta de cuota debe pausar las tareas afectadas y conservar su estado; no debe activar una API de pago automáticamente.

La infraestructura concreta y el diseño visual quedan pendientes. Esta versión documenta la dirección elegida y la propuesta de integración; no inicia su implementación.

## 15. Experiencia web visual

### 15.1 Decisión y objetivo

El creador ha elegido una web muy visual. La composición siguiente es una propuesta para concretar esa intención; todavía no se han elegido colores, estilo gráfico ni framework.

La pantalla principal debe permitir reconocer rápidamente qué está avanzando, quién está trabajando, qué resultados existen y qué necesita intervención. La metáfora de Code Hive Factory puede inspirar la identidad, pero cada elemento visual debe representar información real del proyecto.

### 15.2 Pantalla principal propuesta: vista del equipo

| Zona | Contenido | Interacción |
| --- | --- | --- |
| Cabecera del proyecto | Objetivo actual, estado general y decisiones pendientes. | Abrir contexto y decisiones. |
| Equipo activo | Tarjetas por agente con rol, motor, tarea actual, estado y número de workers ocupados/disponibles. | Seleccionar un agente y consultar su trabajo y cola. |
| Trabajo del proyecto | Tarjetas de tareas con estado, responsable, dependencias y hallazgos. | Abrir detalle o solicitar un cambio de prioridad. |
| Chat del orquestador | Conversación principal, propuestas y preguntas vinculadas al trabajo. | Dar instrucciones mientras el equipo sigue avanzando. |
| Actividad relevante | Entregas, revisiones, peticiones de ayuda y bloqueos. | Saltar al resultado o tarea correspondiente. |

La vista del equipo será el centro visual propuesto. Se podrá alternar con un tablero de tareas cuando interese inspeccionar el trabajo por estados. No es necesario mostrar todas las vistas completas simultáneamente.

Al seleccionar un agente se resaltarán sus tareas y colaboraciones relacionadas. Las conexiones entre agentes se mostrarán cuando exista una interacción relevante o al inspeccionarlas; no habrá una maraña permanente de líneas. Una animación de actividad solo corresponderá a eventos o estados reales.

### 15.3 Detalle sin perder el contexto

Al abrir una tarea o agente se propone un panel lateral con objetivo, estado, resultados, mensajes relevantes, hallazgos y cambios de código. El usuario podrá ampliar los detalles técnicos cuando los necesite.

La actividad tendrá dos niveles: resumen de hechos comprensibles y registro detallado de ejecución. El resumen debe distinguir lo que un agente está intentando de lo que ya ha completado y verificado.

Si el reviewer encuentra un problema, la tarea mostrará el hallazgo, su impacto y el responsable de corregirlo. Cuando la corrección se publique, el mismo recorrido permitirá consultar la nueva revisión. El usuario podrá seguir el hilo completo sin reconstruirlo a partir de conversaciones separadas.

### 15.4 Uso desde ordenador y móvil

Se propone una web adaptable a ambos formatos. En ordenador, combinar vista del equipo y chat lateral. En móvil, ofrecer navegación entre Equipo, Tareas y Chat, con un acceso claro a decisiones pendientes. El detalle se abrirá como pantalla completa cuando no haya espacio para un panel lateral.

El chat conservará su borrador al cambiar de vista. Los estados se reconocerán mediante texto e iconos además del color; las animaciones tendrán una alternativa de movimiento reducido. La lectura de mensajes y acciones principales no debe exigir zoom.

### 15.5 Acciones y comportamiento

Las acciones propuestas son hablar con el orquestador, consultar resultados, responder a decisiones y solicitar pausa, continuación o cambio de prioridad. El estado mostrado debe reflejar la confirmación del coordinador o motor: solicitar una pausa no equivale a que la ejecución ya esté detenida.

Cerrar la web no debe cancelar trabajos activos en el entorno que los ejecuta. Al volver, la interfaz recuperará el estado persistido. Si pierde conexión, indicará que la información puede estar desactualizada en lugar de simular progreso. La persistencia efectiva de la ejecución dependerá de que el equipo o servidor permanezca disponible.

### 15.6 Criterios de aceptación visual

- Se puede identificar la tarea de cada agente sin abrir sus registros.
- Un bloqueo indica qué falta y quién puede resolverlo.
- Se distingue entre actividad en curso, resultado entregado y resultado validado.
- Una petición de ayuda permite seguir la relación entre solicitante, colaborador y tarea.
- El chat y las decisiones pendientes son accesibles durante la ejecución.
- La vista móvil permite consultar el estado y conversar sin depender de la composición de escritorio.
- Una desconexión, límite de uso o pausa pendiente se representa con su estado real.

El siguiente trabajo de diseño será concretar la composición y estilo visual de esta propuesta. El alojamiento y la ubicación de los motores siguen abiertos; elegir una web no fija esas decisiones.

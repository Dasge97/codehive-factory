# 09 · Plan de implementación

Tres fases. La fase 0 valida el motor antes de construir nada (decisión D20). La fase 1
entrega un sistema utilizable. La fase 2 la construye el propio sistema (decisión D07).

Cada tarea indica de qué depende y cuándo se da por hecha. Ninguna tarea se da por hecha
sin que su criterio se cumpla y se pueda enseñar.

---

## Fase 0 · Validar el motor — TERMINADA el 6 de septiembre de 2026

Resultado en [11 · Capacidades de Claude Code](11-capacidades-claude-code.md). Todas las
comprobaciones pasaron. Tres cambios de diseño salieron de ella: decisiones D21, D22 y D23.

Objetivo: saber qué permite Claude Code con la cuenta del creador antes de diseñar
alrededor de suposiciones.

| ID | Tarea | Depende de | Hecha cuando |
| --- | --- | --- | --- |
| F0-01 | Inicializar el repositorio local y conectarlo con el remoto público. | — | El repositorio local tiene la documentación y está sincronizado con el remoto. |
| F0-02 | Ejecutar Claude Code de forma programática con salida estructurada y capturar los eventos. | F0-01 | Un script lanza una instrucción y guarda los eventos recibidos en un fichero legible. |
| F0-03 | Continuar una sesión anterior en una ejecución nueva. | F0-02 | La segunda ejecución demuestra que conserva el contexto de la primera. |
| F0-04 | Restringir las herramientas disponibles y provocar una petición de autorización. | F0-02 | Una acción prohibida no se ejecuta; una que requiere permiso genera una petición que el script puede responder. |
| F0-05 | Parar una ejecución en curso. | F0-02 | El proceso termina, el script lo detecta y el worktree queda inspeccionable. |
| F0-06 | Detectar falta de cuota y fallo de autenticación. | F0-02 | El script distingue esos dos casos de un error normal de ejecución. |
| F0-07 | Dos ejecuciones simultáneas en worktrees distintos del mismo repositorio. | F0-02 | Ambas terminan con commits en sus ramas y sin interferirse. |
| F0-08 | Escribir el documento de capacidades del adaptador de Claude Code. | F0-02 a F0-07 | Existe una tabla que dice qué operación del documento 03 funciona, con qué versión y con qué limitaciones. |

**Si alguna comprobación falla**, no se sigue a la fase 1 sin registrar una decisión
nueva que explique cómo se sustituye esa capacidad.

---

## Fase 1 · Sistema utilizable — TERMINADA el 6 de septiembre de 2026

Las 27 tareas están hechas y las 14 pruebas de aceptación pasan. El detalle está en
[10 · Pruebas de aceptación](10-pruebas-aceptacion.md).

El ciclo completo funcionó también con agentes reales sobre el propio repositorio: el
creador pidió una guía por el chat, el orquestador repartió, el builder la escribió, el
reviewer la aprobó y el creador la integró.

Objetivo: el creador pide un cambio, cuatro agentes lo construyen y lo revisan, y el
creador integra desde la web.

### Base

| ID | Tarea | Depende de | Hecha cuando |
| --- | --- | --- | --- |
| F1-01 | Esqueleto del proyecto: TypeScript, estructura de carpetas del documento 03, scripts de arranque y pruebas. | F0-08 | `npm test` y `npm run dev` funcionan sobre un proyecto vacío. |
| F1-02 | Esquema de base de datos y sistema de migraciones. | F1-01 | Se crea la base de datos desde cero con el esquema del documento 04. |
| F1-03 | Tipos compartidos entre servidor y web. | F1-01 | Los formatos del documento 05 existen como tipos y se validan en tiempo de ejecución. |

### Núcleo de coordinación

| ID | Tarea | Depende de | Hecha cuando |
| --- | --- | --- | --- |
| F1-04 | Creación de tareas, transiciones de estado y las reglas de integridad del apartado 4.5. | F1-02, F1-03 | Cada transición válida e inválida tiene una prueba. |
| F1-05 | Registro de eventos y publicación a los suscriptores. | F1-04 | Cada cambio de estado deja un evento y los suscriptores lo reciben. |
| F1-06 | Consulta de cola y reclamación atómica. | F1-04 | Una prueba lanza dos reclamaciones simultáneas y solo una se queda con la tarea. |
| F1-07 | Bloqueos de recursos por patrón de ruta. | F1-06 | Una tarea con un patrón ya reservado no aparece en la cola hasta que se libera. |

### Ejecución

| ID | Tarea | Depende de | Hecha cuando |
| --- | --- | --- | --- |
| F1-08 | Adaptador de Claude Code con la interfaz del apartado 3.4. | F0-08, F1-03 | El adaptador ejecuta, informa de progreso, admite parada y declara sus capacidades. |
| F1-09 | Proceso worker: prepara el worktree, construye el encargo, lanza el motor y guarda el resultado. | F1-06, F1-08 | Un worker completa una tarea real de principio a fin y deja un commit. |
| F1-10 | Validación del fichero de resultado del agente. | F1-09 | Un resultado ausente o mal formado marca la ejecución como fallida con un motivo claro. |
| F1-11 | Supervisor: arranca workers cuando hay trabajo y los para cuando no lo hay. | F1-09 | Con cuatro agentes configurados, el supervisor no arranca ningún worker si la cola está vacía. |

### Ciclo de trabajo

| ID | Tarea | Depende de | Hecha cuando |
| --- | --- | --- | --- |
| F1-12 | Creación automática de la tarea de revisión al publicarse un incremento. | F1-09 | Un incremento del builder genera la tarea de revisión con el commit correcto. |
| F1-13 | Hallazgos y tareas de corrección, con límite de reintentos y ajuste de prioridad por antigüedad. | F1-12 | Un hallazgo bloqueante crea la corrección; superar los intentos deja la tarea bloqueada con historial. |
| F1-14 | Herramientas del orquestador del apartado 5.6. | F1-04 | El orquestador crea, prioriza y cancela tareas, y no puede escribir código. |
| F1-15 | Bucle del orquestador y chat con el creador. | F1-14, F1-11 | Un mensaje del creador produce tareas y una respuesta en el chat. |

### Servidor y recuperación

| ID | Tarea | Depende de | Hecha cuando |
| --- | --- | --- | --- |
| F1-16 | API HTTP y canal de Server-Sent Events del apartado 5.5. | F1-05 | Un cliente recibe eventos en vivo y recupera lo perdido tras reconectar. |
| F1-17 | Integración con confirmación del creador, verificación posterior y reversión si falla. | F1-13, F1-16 | Una fusión que rompe las verificaciones se deshace y abre un hallazgo bloqueante. |
| F1-18 | Recuperación al arrancar: ejecuciones interrumpidas y worktrees reutilizables. | F1-09 | Tras matar el proceso principal y volver a arrancar, las tareas afectadas vuelven a estar listas. |
| F1-19 | Límites de consumo y comportamiento ante falta de cuota. | F1-08, F1-11 | Con cuota agotada simulada, las tareas quedan bloqueadas y el supervisor deja de arrancar workers. |

### Interfaz

| ID | Tarea | Depende de | Hecha cuando |
| --- | --- | --- | --- |
| F1-20 | Diseño visual: colores, tipografía, iconos de estado y composición. | F1-16 | Existe una propuesta aprobada por el creador. |
| F1-21 | Vista del equipo. | F1-20 | Cumple los criterios del apartado 8.9 relativos a agentes y actividad. |
| F1-22 | Detalle de tarea con ejecuciones, incrementos y hallazgos. | F1-21 | Se sigue el recorrido completo de un hallazgo hasta su corrección sin salir de la vista. |
| F1-23 | Chat y decisiones pendientes. | F1-21 | El borrador se conserva al cambiar de vista y las autorizaciones no se pueden ocultar. |
| F1-24 | Vista de tablero por estados. | F1-21 | Muestra las mismas tareas agrupadas por estado. |
| F1-25 | Adaptación a móvil. | F1-21, F1-22, F1-23 | Las tres secciones funcionan en pantalla de móvil sin ampliar. |

### Cierre

| ID | Tarea | Depende de | Hecha cuando |
| --- | --- | --- | --- |
| F1-26 | Registro de un proyecto y guía de arranque. | F1-17, F1-25 | Un proyecto nuevo se registra con su fichero de configuración y el sistema arranca. |
| F1-27 | Pruebas de aceptación de la fase 1. | todas las anteriores | Las pruebas del documento 10 marcadas como fase 1 pasan. |

---

## Fase 2 · Concurrencia, colaboración y segundo motor

La construye el propio sistema, con el creador dirigiendo desde el chat.

| ID | Tarea | Estado | Hecha cuando |
| --- | --- | --- | --- |
| F2-01 | Varios workers por agente. | Hecha | Dos workers del mismo rol trabajan a la vez sin reclamar la misma tarea. |
| F2-02 | Vigencia renovable de las asignaciones y detección de workers caídos. | Hecha | Un worker que deja de renovar libera su tarea y el sistema la reasigna. |
| F2-03 | Control de resultados tardíos. | Hecha | Un resultado de una ejecución ya sustituida no cambia el estado vigente. |
| F2-04 | Mensajes entre agentes: consulta, aviso, petición de apoyo y escalado. | Hecha | Un builder pide apoyo, se crea la tarea del investigador y la suya espera. |
| F2-05 | Directorio de equipo consultable por los agentes. | Hecha | El encargo de cada agente lleva quién está disponible y con qué está. |
| F2-06 | Adaptador de Codex. | Pendiente | Pasa las mismas comprobaciones de la fase 0 y declara sus capacidades. |
| F2-07 | Motor configurable por agente desde la web. | Pendiente | El reviewer se ejecuta con Codex mientras el builder usa Claude Code. |
| F2-08 | Pruebas de aceptación de la fase 2. | Parcial | P2-01 a P2-05 pasan. P2-06 espera al adaptador de Codex. |

---

## Orden de ataque recomendado

F0-01 a F0-08 en serie. Después F1-01, F1-02 y F1-03, que desbloquean casi todo lo demás.
Luego el camino F1-04 → F1-06 → F1-09 → F1-12, que es el que produce el primer ciclo
completo de construcción y revisión. La interfaz puede empezar en cuanto exista F1-16.

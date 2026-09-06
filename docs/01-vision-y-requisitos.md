# 01 · Visión y requisitos

## 1.1 Qué se construye

Code Hive Factory es un sistema que ejecuta y coordina agentes de programación sobre los
proyectos del creador. El creador escribe en un chat qué quiere conseguir. Un agente
orquestador convierte esa petición en tareas concretas. Otros agentes las ejecutan,
revisan el resultado y corrigen los fallos encontrados. Todo el estado se guarda en una
base de datos y se muestra en una web.

## 1.2 Para quién

Un único usuario: el creador. El sistema no tiene registro de usuarios, roles de
permisos ni multiempresa. Si en el futuro se distribuye, será un cambio de producto que
requerirá revisar autenticación, aislamiento y condiciones de uso de los proveedores.

## 1.3 Qué problema resuelve

Trabajar con un solo agente de programación obliga al creador a hacer de coordinador:
decidir el orden, recordar qué quedó pendiente, revisar cada entrega y volver a
explicar el contexto en cada sesión. Code Hive Factory traslada esa coordinación al
sistema y deja al creador la dirección del producto.

## 1.4 Requisitos confirmados

Estos requisitos vienen del creador y no se cambian sin su acuerdo explícito.

| ID | Requisito |
| --- | --- |
| A01 | El creador se comunica con un agente orquestador que reparte tareas específicas. |
| A02 | Los agentes pueden trabajar simultáneamente cuando sus tareas lo permiten. |
| A03 | No existe un ciclo global rígido en el que todos los agentes esperan al agente de turno. |
| A04 | El builder puede atender una corrección detectada por el reviewer sin esperar a otra fase del proyecto. |
| A05 | El sistema dispone de colas de trabajo y workers por agente. |
| A06 | Los agentes conocen la existencia de los demás y pueden ayudarse entre ellos. |
| A07 | La complejidad se mantiene intermedia y práctica para la escala del creador. |
| A08 | Los motores de ejecución son Claude Code y Codex, usados con las suscripciones del creador. |
| A09 | El creador diseña la interfaz visual del sistema. |
| A10 | La interfaz es una web muy visual. |

Sobre A08: el requisito expresa la voluntad de usar las suscripciones. No garantiza que
cada proveedor permita ese uso de forma indefinida. La comprobación real se hace en la
fase 0 del plan de implementación.

## 1.5 Fuera de alcance

- Varios usuarios simultáneos.
- Distribución del producto a terceros.
- Acceso a la web desde fuera de la red local.
- Despliegue automático a producción de los proyectos gestionados.
- Acceso directo a las API de pago de los modelos.

## 1.6 Glosario

Estos términos se usan con este significado exacto en todos los documentos y en el código.

| Término | Significado |
| --- | --- |
| Proyecto | Un repositorio de código sobre el que trabaja el equipo, con su objetivo, decisiones y tareas. |
| Orquestador | Agente que habla con el creador, crea tareas, fija prioridades y resuelve contradicciones. |
| Rol | Responsabilidad: orquestador, builder, reviewer o investigador. |
| Agente | Identidad configurada: un rol, un motor, unas instrucciones y unos permisos. |
| Worker | Proceso que toma una tarea y la ejecuta. Un agente puede tener uno o varios workers. |
| Tarea | Unidad de trabajo con objetivo, alcance, dependencias y criterios de aceptación. |
| Ejecución | Un intento concreto de un worker sobre una tarea. Tiene inicio, fin, resultado y consumo. |
| Cola | Consulta sobre la tabla de tareas que devuelve el trabajo disponible para un agente. |
| Evento | Hecho registrado e inmutable: tarea creada, ejecución terminada, hallazgo abierto, etc. |
| Incremento | Un commit en la rama de una tarea. Es la unidad que el reviewer revisa. |
| Hallazgo | Problema detectado por el reviewer sobre un incremento concreto. |
| Bloqueo de recurso | Reserva exclusiva de un conjunto de ficheros mientras una tarea los modifica. |

## 1.7 Qué se considera éxito

- El creador pide un cambio en lenguaje natural y obtiene código revisado sin coordinar el trabajo a mano.
- Dos tareas independientes avanzan a la vez y el creador lo ve en la web.
- Un fallo detectado por el reviewer se corrige sin que el resto del proyecto se detenga.
- El creador cierra la web, la vuelve a abrir y encuentra el estado real del trabajo.

Mantener a todos los agentes ocupados no es una medida de éxito.

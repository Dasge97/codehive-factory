# 08 · Interfaz web

React con Vite, servida por el proceso principal en la red local (decisión D06). El
estilo visual concreto se decide al empezar la tarea de diseño; este documento fija qué
información se muestra y qué se puede hacer.

## 8.1 Regla que gobierna toda la interfaz

Cada elemento visual representa un dato real de la base de datos. No hay barras de
progreso inventadas, ni porcentajes estimados, ni animaciones que sugieran actividad
donde no la hay.

Si un adaptador de motor no publica un dato, la interfaz dice que no está disponible en
lugar de rellenarlo.

## 8.2 Pantalla principal: vista del equipo

| Zona | Qué muestra | Qué se puede hacer |
| --- | --- | --- |
| Cabecera | Nombre y objetivo del proyecto, estado general, avisos de cuota y decisiones pendientes de respuesta. | Abrir la lista de decisiones. |
| Equipo | Una tarjeta por agente: rol, motor, tarea actual, estado de su ejecución y workers ocupados sobre el total. | Seleccionar un agente. |
| Trabajo | Tarjetas de tarea: título, estado, responsable, dependencias sin cerrar y hallazgos abiertos. | Abrir el detalle, cambiar la prioridad, cancelar. |
| Chat | Conversación con el orquestador. | Escribir mientras el equipo trabaja. |
| Actividad | Últimos eventos en lenguaje llano: incrementos publicados, revisiones, bloqueos y peticiones de ayuda. | Saltar a la tarea correspondiente. |

Al seleccionar un agente se resaltan sus tareas en la zona de trabajo y las relaciones
con otros agentes. Las líneas entre agentes aparecen solo cuando hay una interacción real
que mostrar.

## 8.3 Vista de tablero

Alternativa a la vista del equipo. Columnas por estado de tarea: pendiente, lista, en
curso, en revisión, bloqueada, hecha. Sirve para inspeccionar el trabajo por estado en
vez de por persona.

## 8.4 Detalle de una tarea

Panel lateral en pantalla grande, pantalla completa en móvil. Contiene:

- Objetivo, alcance y criterios de aceptación.
- Estado actual y motivo si está bloqueada.
- Dependencias, con enlace a cada una.
- Ficheros reservados por la tarea.
- Ejecuciones, con resumen, duración y consumo.
- Incrementos, con el commit y los ficheros tocados.
- Hallazgos, con su gravedad, su condición de resolución y la tarea de corrección.
- Registro detallado de ejecución, plegado.

El resumen y el registro detallado son dos niveles distintos. El resumen dice qué se ha
completado y verificado. El registro dice qué se intentó.

## 8.5 Botón de integración

Aparece en el detalle de una tarea cuando está en estado `done`, tiene commit y no tiene
hallazgos bloqueantes abiertos. Antes de confirmar muestra: la rama, el número de
commits, los ficheros que cambian y el comando de verificación que se va a ejecutar.

## 8.6 Autorizaciones

Una petición de autorización pendiente se muestra en la cabecera y en la tarjeta del
agente afectado, y no se puede ocultar. Indica qué pide el motor, en qué tarea y cuánto
tiempo lleva esperando.

## 8.7 Móvil

Navegación entre tres secciones: Equipo, Tareas y Chat. Las decisiones pendientes y las
autorizaciones tienen acceso directo desde cualquiera de las tres.

El borrador del chat se conserva al cambiar de sección. El estado se distingue por texto
e icono además de por color. Las animaciones tienen alternativa de movimiento reducido.
Leer un mensaje o pulsar una acción no exige ampliar la pantalla.

## 8.8 Conexión y estado real

Cerrar la web no detiene el trabajo: los procesos siguen en el equipo. Al volver a
abrirla, la web pide el estado y se reconstruye desde la base de datos.

Si se pierde el canal de eventos, la web lo indica y marca la información como posible
desactualizada. No simula progreso. Al reconectar pide los eventos desde el último
identificador recibido.

Pedir una pausa no equivale a que la ejecución esté detenida. La web muestra «pausa
solicitada» hasta que llega la confirmación del worker.

## 8.9 Ajustes

Un panel accesible desde la cabecera reúne lo que el creador puede configurar sin editar
ficheros:

- Pausar el proyecto o reanudarlo. En pausa, el trabajo en curso termina y no se arranca
  nada nuevo. La pantalla principal lo dice mientras dure.
- El motor de cada agente, entre los que están instalados de verdad. Un motor que falta
  aparece con su motivo, no como una opción que luego fallaría.
- Cuántos workers puede tener un agente a la vez, y si está activo.
- Qué sabe hacer cada motor. Se lee de lo que declara su adaptador, así que la web no
  promete un dato que el motor no publica.

## 8.10 Criterios de aceptación

- Se identifica en qué trabaja cada agente sin abrir su registro de ejecución.
- Un bloqueo indica qué falta y quién puede resolverlo.
- Se distinguen tres cosas distintas: trabajo en curso, incremento entregado e incremento validado.
- Una petición de ayuda deja ver quién la pidió, quién responde y sobre qué tarea.
- El chat y las decisiones pendientes son accesibles mientras el equipo trabaja.
- La vista móvil permite consultar el estado y conversar sin depender de la composición de escritorio.
- Una desconexión, una falta de cuota o una pausa pendiente se muestran con su estado real.
- Ninguna cifra mostrada procede de una estimación del propio sistema.

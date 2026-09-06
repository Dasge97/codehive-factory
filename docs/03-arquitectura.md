# 03 · Arquitectura

Todo lo descrito aquí se ejecuta en el equipo Windows del creador (decisión D01).

## 3.1 Componentes

| Componente | Qué hace | Tecnología |
| --- | --- | --- |
| Servicio de coordinación | Guarda el estado, reparte tareas, aplica bloqueos y publica eventos. | Node con TypeScript, SQLite. |
| Supervisor de workers | Arranca y para los procesos de los workers según haya trabajo. | Node, dentro del mismo proceso que el servicio de coordinación. |
| Worker | Toma una tarea, prepara su espacio de trabajo, invoca el motor y guarda el resultado. | Proceso hijo de Node. |
| Adaptador de motor | Traduce entre el contrato interno y la herramienta concreta de ejecución. | Módulo TypeScript con una interfaz común. |
| Motor | Ejecuta la sesión de programación. En la fase 1, Claude Code. | Proceso externo. |
| Web | Muestra el estado y recoge las órdenes del creador. | React con Vite. |
| Espacios de trabajo | Un worktree de Git por tarea que toca código. | Directorios en disco. |

## 3.2 Procesos en ejecución

Hay un proceso principal y un proceso hijo por worker activo.

El proceso principal contiene el servicio de coordinación, el servidor HTTP que sirve la
web y su API, y el supervisor de workers. Es el único que escribe en la base de datos.

Cada worker es un proceso hijo. No abre la base de datos: pide trabajo y publica
resultados llamando a la API interna del proceso principal. Cada worker lanza a su vez
el proceso del motor y lee su salida.

**Por qué los workers no tocan la base de datos:** concentra toda la escritura en un
proceso. La reclamación atómica y los bloqueos se resuelven en un solo sitio y son fáciles
de probar.

## 3.3 Cómo circula la información

**El creador pide algo.** Escribe en el chat de la web. La web envía el mensaje al
servicio de coordinación. El servicio lo guarda y despierta al worker del orquestador.

**El orquestador reparte.** Su sesión de motor recibe el mensaje, el estado actual del
proyecto y las decisiones vigentes. Responde creando tareas y ajustando prioridades
mediante sus herramientas. El servicio guarda cada cambio y publica un evento.

**Un worker toma trabajo.** El supervisor ve tareas en estado listo cuyo rol coincide con
un agente que tiene un worker libre. Arranca el worker. El worker reclama la tarea con
una transacción, prepara su worktree y lanza el motor.

**El motor trabaja.** El worker lee su salida estructurada y va guardando eventos de
progreso. La web los recibe por Server-Sent Events y actualiza la pantalla.

**El worker termina.** Guarda el resultado, el identificador del commit si lo hay, el
consumo y el estado final de la ejecución. Si el trabajo era de construcción, la tarea
pasa a revisión y se crea la tarea de revisión correspondiente.

**El reviewer revisa.** Toma la tarea de revisión, examina el commit indicado y publica
hallazgos o conformidad. Cada hallazgo crea una tarea de corrección dirigida al agente
que produjo el incremento.

**El creador integra.** Cuando una tarea tiene conformidad del reviewer, la web muestra
un botón de integración. Al confirmarlo, el servicio fusiona la rama de la tarea en la
rama principal, ejecuta las verificaciones del proyecto y publica el resultado.

## 3.4 Interfaz del adaptador de motor

Todo adaptador ofrece las mismas operaciones. Es lo que permite añadir Codex en la fase 2
sin tocar el resto del sistema.

| Operación | Qué recibe | Qué devuelve |
| --- | --- | --- |
| Iniciar ejecución | Instrucciones, directorio de trabajo, herramientas permitidas e identificador de sesión anterior si lo hay. | Un flujo de eventos y un identificador de ejecución. |
| Leer eventos | El identificador de ejecución. | Eventos de progreso: mensaje, uso de herramienta, petición de autorización, error. |
| Responder autorización | El identificador de la petición y la respuesta. | Confirmación. |
| Parar ejecución | El identificador de ejecución. | Confirmación de parada. |
| Consultar capacidades | Nada. | Qué operaciones soporta realmente este motor. |

La consulta de capacidades existe porque no todos los motores soportarán todo. La web
muestra solo lo que el adaptador declara.

## 3.5 Estructura de carpetas

```
codehive-factory/
  docs/              Documentación
  src/
    core/            Estado, tareas, colas, bloqueos y eventos
    engines/         Adaptadores de motor
    workers/         Código del proceso worker
    server/          API HTTP y canal de eventos
    shared/          Tipos compartidos entre servidor y web
  web/               Aplicación React
  data/              Base de datos SQLite (fuera del control de versiones)
  workspaces/        Worktrees de Git de las tareas (fuera del control de versiones)
```

## 3.6 Arranque y parada

Al arrancar, el servicio abre la base de datos, marca como interrumpidas las ejecuciones
que figuraban activas, devuelve sus tareas al estado listo y anota el motivo. Después
levanta el servidor HTTP y el supervisor.

Al parar, el supervisor pide parada a cada worker activo. Un worker en medio de una
ejecución la cancela, guarda lo que tenga y sale. El worktree se conserva para poder
inspeccionarlo.

## 3.7 Qué no hace esta arquitectura

- No reparte trabajo entre varias máquinas.
- No aísla los agentes en contenedores. Un agente puede ejecutar cualquier comando dentro de su worktree.
- No cifra la base de datos.
- No autentica a quien abre la web en la red local.

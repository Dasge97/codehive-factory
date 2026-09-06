# 05 · Contratos

Formatos que intercambian el servicio de coordinación, los workers, los motores y la web.
Los tipos viven en `src/shared/` y se usan tanto en el servidor como en la web.

## 5.1 Encargo entregado a un agente

Es lo que el worker construye y pasa al motor como contexto de la ejecución. Se genera
siempre desde la base de datos, nunca a mano.

```json
{
  "task": {
    "id": "tsk_...",
    "kind": "build",
    "title": "...",
    "goal": "...",
    "scope": "...",
    "acceptance": "...",
    "priority": 40
  },
  "project": {
    "id": "prj_...",
    "name": "...",
    "goal": "...",
    "main_branch": "main",
    "verify_command": "npm test"
  },
  "workspace": {
    "path": "...",
    "branch": "task/tsk_...",
    "base_commit": "..."
  },
  "decisions": [
    { "title": "...", "body": "...", "revision": 2 }
  ],
  "dependencies": [
    { "id": "tsk_...", "title": "...", "status": "done", "result": "..." }
  ],
  "locks": ["src/core/**"],
  "findings": [
    { "id": "fnd_...", "severity": "blocker", "title": "...", "detail": "...", "resolution": "..." }
  ],
  "team": [
    { "agent_id": "agt_...", "name": "...", "role": "reviewer", "available": true }
  ],
  "notices": [
    { "from": "agt_...", "body": "..." }
  ],
  "previous_run": {
    "id": "run_...",
    "summary": "...",
    "engine_session_id": "..."
  }
}
```

**Qué incluye y qué no.** Incluye el objetivo del proyecto, las decisiones vigentes, el
alcance propio de la tarea y sus relaciones con otras. No incluye el historial completo
de los demás agentes. La lista `team` existe para cumplir el requisito A06: cada agente
sabe quién más existe y qué rol tiene.

El campo `notices` recoge los avisos que llegaron mientras el worker ejecutaba la vez
anterior. Es el mecanismo del punto seguro descrito en la decisión D12.

## 5.2 Resultado que devuelve un agente

El worker pasa el esquema de este objeto al motor con la opción `--json-schema`. El motor
devuelve un resultado que lo cumple, en el campo `result` del evento final. El worker lo
convierte a objeto y lo valida antes de guardarlo (decisión D21).

```json
{
  "outcome": "completed",
  "summary": "Qué se ha hecho, en dos o tres frases.",
  "commit": "a1b2c3d",
  "verification": {
    "ran": true,
    "command": "npm test",
    "passed": true,
    "output_excerpt": "..."
  },
  "findings": [],
  "questions": [],
  "needs": []
}
```

| Campo | Significado |
| --- | --- |
| `outcome` | `completed`, `partial`, `blocked` o `failed`. |
| `summary` | Explicación en lenguaje llano. Es lo que ve el creador en la web. |
| `commit` | Identificador del incremento publicado, si la tarea tocaba código. |
| `verification` | Si el agente ejecutó las verificaciones del proyecto y qué salió. |
| `findings` | Solo lo rellena el reviewer. Un elemento por problema detectado. |
| `questions` | Preguntas que bloquean el trabajo y necesitan respuesta del orquestador o del creador. |
| `needs` | Peticiones de apoyo a otro rol. Generan una tarea nueva. |

**Por qué un esquema y no el texto libre del modelo.** El texto libre no es fiable como
formato de datos. El motor hace cumplir el esquema, y si el resultado falta o no valida,
la ejecución se marca como fallida con un motivo claro.

## 5.3 Hallazgo

```json
{
  "severity": "blocker",
  "title": "La validación de nombres acepta cadena vacía",
  "detail": "Problema, impacto y evidencia. Incluye cómo reproducirlo.",
  "resolution": "Qué debe cumplirse para darlo por resuelto.",
  "file_path": "src/projects/validate.ts",
  "line": 42
}
```

| Gravedad | Efecto |
| --- | --- |
| `blocker` | Impide integrar. Crea una tarea de corrección de prioridad alta. |
| `major` | Crea una tarea de corrección. No impide integrar si el creador lo acepta. |
| `minor` | Se registra. La corrección es opcional y la decide el orquestador. |

Un hallazgo se refiere siempre a un incremento concreto. Aprobar un incremento no aprueba
los cambios posteriores.

## 5.4 Eventos

Todo cambio de estado publica un evento. La web se dibuja a partir de ellos.

| Tipo | Cuándo | Datos principales |
| --- | --- | --- |
| `task.created` | El orquestador o un agente crea una tarea. | Tarea completa. |
| `task.status_changed` | Cambia el estado de una tarea. | Estado anterior, estado nuevo, motivo. |
| `task.blocked` | Una tarea no puede continuar. | Motivo y quién puede desbloquearla. |
| `run.started` | Un worker empieza una ejecución. | Tarea, agente, motor. |
| `run.progress` | El motor informa de un paso. | Texto del paso y herramienta usada. |
| `run.finished` | Termina una ejecución. | Estado final, resumen, consumo. |
| `increment.published` | Un agente publica un commit. | Commit, rama, ficheros. |
| `finding.opened` | El reviewer detecta un problema. | Hallazgo y tarea de corrección creada. |
| `finding.resolved` | Un hallazgo se da por resuelto. | Hallazgo y ejecución que lo resolvió. |
| `approval.requested` | El motor pide autorización. | Qué pide y en qué ejecución. |
| `approval.resolved` | El creador responde. | Respuesta. |
| `decision.recorded` | Se registra o se cambia una decisión. | Decisión y tareas marcadas para reevaluar. |
| `chat.message` | Mensaje del creador o del orquestador. | Autor y cuerpo. |
| `integration.completed` | Una rama se fusiona en la principal. | Resultado de las verificaciones. |
| `quota.exhausted` | Un motor informa de falta de cuota. | Motor y tareas afectadas. |

Los eventos son inmutables. No se corrigen: se publica un evento nuevo.

## 5.5 API HTTP

Todas las rutas cuelgan de `/api`.

| Método y ruta | Qué hace |
| --- | --- |
| `GET /projects` | Lista de proyectos. |
| `GET /projects/:id` | Estado del proyecto: objetivo, decisiones pendientes, resumen. |
| `GET /projects/:id/tasks` | Tareas, con filtro por estado y por rol. |
| `GET /tasks/:id` | Detalle de una tarea: ejecuciones, incrementos, hallazgos y mensajes. |
| `POST /projects/:id/chat` | El creador envía un mensaje al orquestador. |
| `POST /tasks/:id/priority` | Cambia la prioridad de una tarea. |
| `POST /tasks/:id/cancel` | Cancela una tarea. |
| `POST /tasks/:id/integrate` | Fusiona la rama de la tarea en la principal. Requiere confirmación del creador. |
| `POST /runs/:id/stop` | Para una ejecución en curso. |
| `POST /approvals/:id` | Responde a una petición de autorización. |
| `GET /projects/:id/events` | Canal de Server-Sent Events con los eventos en vivo. |

El canal de eventos acepta el parámetro `since` con el último identificador de evento
recibido. Al reconectar, la web pide desde ahí y no pierde nada.

## 5.6 Herramientas del orquestador

El orquestador no escribe código. Sus herramientas actúan sobre el registro de tareas
(decisión D16).

| Herramienta | Qué hace |
| --- | --- |
| `crear_tarea` | Crea una tarea con objetivo, alcance, criterios, rol, prioridad, dependencias y patrones de ruta. |
| `actualizar_tarea` | Cambia prioridad, alcance o criterios de una tarea que no está en curso. |
| `cancelar_tarea` | Cancela una tarea con un motivo. |
| `registrar_decision` | Guarda una decisión de producto y marca las tareas afectadas para reevaluar. |
| `consultar_estado` | Devuelve el estado del proyecto, las colas y los bloqueos. |
| `responder_creador` | Escribe un mensaje en el chat. |
| `pedir_investigacion` | Crea una tarea para el investigador a partir de una pregunta concreta. |

## 5.7 Configuración de un proyecto

Fichero `codehive.project.json` en la raíz del repositorio gestionado. Lo lee el sistema
al registrar el proyecto.

```json
{
  "name": "Nombre del proyecto",
  "main_branch": "main",
  "verify_command": "npm test",
  "install_command": "npm ci",
  "max_concurrent_runs": 4,
  "max_task_attempts": 3,
  "protected_paths": ["package-lock.json", ".github/**"]
}
```

`protected_paths` marca ficheros que ningún agente puede modificar sin una tarea creada
expresamente para ello por el creador.

# 04 · Modelo de datos

Base de datos SQLite en modo WAL (decisión D02). Un solo fichero. Solo el proceso
principal escribe en ella.

Las marcas de tiempo se guardan como texto en formato ISO 8601 con zona horaria. Los
identificadores son texto: un prefijo que indica el tipo y un identificador único, por
ejemplo `tsk_01H8...`. El prefijo hace legibles los registros y los mensajes de error.

Las tablas marcadas como **fase 2** no se crean en la fase 1.

## 4.1 Esquema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Un proyecto es un repositorio de código gestionado por el sistema.
CREATE TABLE projects (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  repo_path           TEXT NOT NULL,        -- ruta absoluta en el disco del creador
  main_branch         TEXT NOT NULL DEFAULT 'main',
  goal                TEXT,                 -- objetivo actual, lo mantiene el orquestador
  verify_command      TEXT,                 -- comando de verificación tras integrar
  max_concurrent_runs INTEGER NOT NULL DEFAULT 4,
  max_task_attempts   INTEGER NOT NULL DEFAULT 3,
  status              TEXT NOT NULL DEFAULT 'active',  -- active | paused | archived
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- Un agente es una identidad configurada: rol, motor, instrucciones y permisos.
CREATE TABLE agents (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL,             -- orchestrator | builder | reviewer | researcher
  engine         TEXT NOT NULL,             -- claude_code | codex
  model          TEXT,                      -- modelo concreto, si el motor lo permite
  instructions   TEXT NOT NULL,             -- instrucciones fijas del rol
  allowed_tools  TEXT NOT NULL,             -- lista de herramientas en JSON
  max_workers    INTEGER NOT NULL DEFAULT 1,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Una tarea es una unidad de trabajo.
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL,          -- build | review | fix | research | integrate
  title             TEXT NOT NULL,
  goal              TEXT NOT NULL,          -- qué resultado se espera
  scope             TEXT,                   -- qué entra y qué no entra
  acceptance        TEXT,                   -- criterios de aceptación
  required_role     TEXT NOT NULL,          -- rol que puede ejecutarla
  priority          INTEGER NOT NULL DEFAULT 50,   -- menor número, antes se ejecuta
  status            TEXT NOT NULL,          -- pending|ready|in_progress|in_review|blocked|done|cancelled
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  active_run_id     TEXT,                   -- ejecución en curso, si la hay
  branch            TEXT,                   -- rama de Git de la tarea
  workspace_path    TEXT,                   -- worktree asignado
  base_commit       TEXT,                   -- commit de partida
  head_commit       TEXT,                   -- último incremento publicado
  decision_revision INTEGER NOT NULL DEFAULT 1,  -- revisión de requisitos con la que se creó
  needs_reeval      INTEGER NOT NULL DEFAULT 0,  -- 1 si un cambio de requisito la afecta
  attempts          INTEGER NOT NULL DEFAULT 0,
  blocked_reason    TEXT,
  created_by        TEXT NOT NULL,          -- id de agente, o 'creator'
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  closed_at         TEXT
);

CREATE INDEX idx_tasks_queue ON tasks(project_id, status, required_role, priority);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);

-- Una tarea no es reclamable hasta que sus dependencias están cerradas.
CREATE TABLE task_dependencies (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);

-- Ficheros que una tarea va a modificar. Impide que dos tareas toquen lo mismo a la vez.
CREATE TABLE resource_locks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path_pattern  TEXT NOT NULL,              -- patrón glob relativo a la raíz del proyecto
  acquired_at   TEXT NOT NULL,
  released_at   TEXT
);

CREATE INDEX idx_locks_active ON resource_locks(project_id, released_at);

-- Un intento concreto de un worker sobre una tarea.
CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  worker_id         TEXT NOT NULL,          -- identificador del proceso worker
  engine            TEXT NOT NULL,
  engine_session_id TEXT,                   -- sesión del motor, para continuarla
  status            TEXT NOT NULL,          -- running|succeeded|failed|cancelled|interrupted
  input_commit      TEXT,
  output_commit     TEXT,
  summary           TEXT,                   -- qué hizo, escrito por el agente
  error             TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cost_note         TEXT,                   -- lo que el motor informe, si informa algo
  started_at        TEXT NOT NULL,
  ended_at          TEXT
);

CREATE INDEX idx_runs_task ON runs(task_id, started_at);

-- Un incremento: un commit publicado por un agente y revisable.
CREATE TABLE increments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  commit_sha  TEXT NOT NULL,
  branch      TEXT NOT NULL,
  message     TEXT NOT NULL,
  files_json  TEXT,                         -- ficheros tocados, en JSON
  review_status TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  created_at  TEXT NOT NULL
);

-- Un problema detectado por el reviewer sobre un incremento concreto.
CREATE TABLE findings (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  increment_id   TEXT NOT NULL REFERENCES increments(id) ON DELETE CASCADE,
  source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,  -- tarea revisada
  fix_task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,          -- tarea de corrección
  severity       TEXT NOT NULL,             -- blocker | major | minor
  title          TEXT NOT NULL,
  detail         TEXT NOT NULL,             -- problema, impacto y evidencia
  resolution     TEXT NOT NULL,             -- qué debe cumplirse para darlo por resuelto
  file_path      TEXT,
  line           INTEGER,
  status         TEXT NOT NULL DEFAULT 'open',  -- open | fixed | dismissed
  created_at     TEXT NOT NULL,
  resolved_at    TEXT
);

CREATE INDEX idx_findings_open ON findings(project_id, status);

-- Decisiones de producto del creador y del orquestador. Versionadas.
CREATE TABLE decisions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  supersedes_id TEXT REFERENCES decisions(id),
  decided_by    TEXT NOT NULL,              -- 'creator' o id de agente
  created_at    TEXT NOT NULL
);

-- Conversación del creador con el orquestador.
CREATE TABLE chat_messages (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,                 -- 'creator' o id de agente
  body       TEXT NOT NULL,
  task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,  -- si el mensaje va sobre una tarea
  created_at TEXT NOT NULL
);

-- Todo hecho relevante. Es la fuente del historial y de la web en vivo.
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,                 -- ver documento 05
  task_id    TEXT,
  run_id     TEXT,
  agent_id   TEXT,
  payload    TEXT NOT NULL,                 -- JSON con los datos del evento
  created_at TEXT NOT NULL
);

CREATE INDEX idx_events_stream ON events(project_id, id);

-- Peticiones de autorización que el motor eleva al creador.
CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,               -- tool_use | merge | other
  request      TEXT NOT NULL,               -- qué se pide, en texto legible
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | granted | denied | expired
  responded_by TEXT,
  created_at   TEXT NOT NULL,
  responded_at TEXT
);
```

## 4.2 Tablas de la fase 2

```sql
-- Mensajes entre agentes: consultas, avisos y peticiones de apoyo.
CREATE TABLE agent_messages (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id     TEXT NOT NULL,              -- agrupa la conversación
  from_agent_id TEXT NOT NULL REFERENCES agents(id),
  to_agent_id   TEXT REFERENCES agents(id), -- nulo si va a todo el equipo
  kind          TEXT NOT NULL,              -- question | notice | help_request | answer | escalation
  body          TEXT NOT NULL,
  task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  delivered_at  TEXT,                       -- cuándo lo recibió el destinatario
  created_at    TEXT NOT NULL
);

-- Vigencia de una asignación. Detecta workers caídos.
CREATE TABLE leases (
  task_id     TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  worker_id   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  renewed_at  TEXT NOT NULL
);
```

## 4.3 Consulta de la cola

Esta es la consulta que devuelve las tareas que un agente puede reclamar. Contiene las
tres condiciones del diseño: dependencias cerradas, sin conflicto de recursos y
prioridad.

```sql
SELECT t.*
FROM tasks t
WHERE t.project_id = :project_id
  AND t.status = 'ready'
  AND t.required_role = :role
  AND NOT EXISTS (
    SELECT 1 FROM task_dependencies d
    JOIN tasks dep ON dep.id = d.depends_on_id
    WHERE d.task_id = t.id AND dep.status NOT IN ('done', 'cancelled')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM resource_locks want
    JOIN resource_locks held
      ON held.project_id = want.project_id
     AND held.released_at IS NULL
     AND held.task_id <> t.id
     AND held.path_pattern = want.path_pattern
    WHERE want.task_id = t.id AND want.released_at IS NULL
  )
ORDER BY t.priority ASC, t.created_at ASC
LIMIT 1;
```

El cruce de bloqueos compara patrones idénticos. Es una comprobación conservadora y
suficiente para la fase 1, donde el orquestador declara los patrones de forma explícita.
Si en el uso real aparecen solapamientos parciales que hay que detectar, se sustituye por
una comparación de prefijos de ruta.

## 4.4 Reclamación atómica

```sql
BEGIN IMMEDIATE;

UPDATE tasks
SET status = 'in_progress',
    assigned_agent_id = :agent_id,
    active_run_id = :run_id,
    attempts = attempts + 1,
    updated_at = :now
WHERE id = :task_id
  AND status = 'ready'
  AND active_run_id IS NULL;

-- Si el número de filas afectadas es 0, otro worker se adelantó: se deshace y se reintenta.

INSERT INTO resource_locks (id, project_id, task_id, path_pattern, acquired_at)
  VALUES (...);

INSERT INTO runs (...) VALUES (...);

COMMIT;
```

`BEGIN IMMEDIATE` toma el bloqueo de escritura al empezar la transacción. Dos
reclamaciones simultáneas se serializan y solo una encuentra la tarea en estado `ready`.

## 4.5 Reglas de integridad que el código debe garantizar

SQLite no las comprueba por sí solo. Se validan en el código y se cubren con pruebas.

- Una tarea en estado `in_progress` tiene siempre un `active_run_id` que apunta a una ejecución en estado `running`.
- Una tarea en estado `done` no tiene hallazgos abiertos de gravedad `blocker`.
- Un bloqueo de recurso sin `released_at` pertenece siempre a una tarea que no está cerrada.
- Un hallazgo con `fix_task_id` apunta a una tarea de tipo `fix`.
- Las dependencias de tareas no forman ciclos. Se comprueba al crear cada dependencia.

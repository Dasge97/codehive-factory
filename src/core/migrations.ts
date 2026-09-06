/**
 * Migraciones de la base de datos. Cada una se aplica una sola vez, en orden de versión,
 * dentro de una transacción. Nunca se edita una migración ya publicada: los cambios van
 * en una migración nueva, porque las bases de datos existentes ya aplicaron la anterior.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'esquema inicial',
    sql: `
-- Un proyecto es un repositorio de código gestionado por el sistema.
CREATE TABLE projects (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  repo_path           TEXT NOT NULL,
  main_branch         TEXT NOT NULL DEFAULT 'main',
  goal                TEXT,
  verify_command      TEXT,
  install_command     TEXT,
  max_concurrent_runs INTEGER NOT NULL DEFAULT 4,
  max_task_attempts   INTEGER NOT NULL DEFAULT 3,
  run_timeout_ms      INTEGER NOT NULL DEFAULT 900000,
  status              TEXT NOT NULL DEFAULT 'active',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (status IN ('active','paused','archived'))
);

-- Un agente es una identidad configurada: rol, motor, instrucciones y permisos.
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  engine        TEXT NOT NULL,
  model         TEXT,
  instructions  TEXT NOT NULL,
  allowed_tools TEXT NOT NULL,
  max_workers   INTEGER NOT NULL DEFAULT 1,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (role IN ('orchestrator','builder','reviewer','researcher')),
  CHECK (engine IN ('claude_code','codex')),
  CHECK (max_workers >= 1)
);

CREATE INDEX idx_agents_role ON agents(project_id, role, enabled);

-- Una tarea es una unidad de trabajo.
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL,
  title             TEXT NOT NULL,
  goal              TEXT NOT NULL,
  scope             TEXT,
  acceptance        TEXT,
  required_role     TEXT NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 50,
  status            TEXT NOT NULL,
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  active_run_id     TEXT,
  branch            TEXT,
  workspace_path    TEXT,
  base_commit       TEXT,
  head_commit       TEXT,
  decision_revision INTEGER NOT NULL DEFAULT 1,
  needs_reeval      INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  blocked_reason    TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  closed_at         TEXT,
  CHECK (kind IN ('build','review','fix','research','integrate')),
  CHECK (required_role IN ('orchestrator','builder','reviewer','researcher')),
  CHECK (status IN ('pending','ready','in_progress','in_review','blocked','done','cancelled')),
  CHECK (id <> parent_task_id)
);

CREATE INDEX idx_tasks_queue  ON tasks(project_id, status, required_role, priority);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);

-- Una tarea no es reclamable hasta que sus dependencias están cerradas.
CREATE TABLE task_dependencies (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);

CREATE INDEX idx_deps_reverse ON task_dependencies(depends_on_id);

-- Ficheros que una tarea va a modificar. Impide que dos tareas toquen lo mismo a la vez.
CREATE TABLE resource_locks (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path_pattern TEXT NOT NULL,
  acquired_at  TEXT NOT NULL,
  released_at  TEXT
);

CREATE INDEX idx_locks_active ON resource_locks(project_id, released_at, path_pattern);
CREATE INDEX idx_locks_task   ON resource_locks(task_id);

-- Un intento concreto de un worker sobre una tarea.
CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  worker_id         TEXT NOT NULL,
  engine            TEXT NOT NULL,
  engine_session_id TEXT,
  status            TEXT NOT NULL,
  input_commit      TEXT,
  output_commit     TEXT,
  summary           TEXT,
  error             TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cost_usd          REAL,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  CHECK (status IN ('running','succeeded','failed','cancelled','interrupted','timed_out'))
);

CREATE INDEX idx_runs_task   ON runs(task_id, started_at);
CREATE INDEX idx_runs_active ON runs(status);

-- Un incremento: un commit publicado por un agente y revisable.
CREATE TABLE increments (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  commit_sha    TEXT NOT NULL,
  branch        TEXT NOT NULL,
  message       TEXT NOT NULL,
  files_json    TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL,
  CHECK (review_status IN ('pending','approved','rejected'))
);

CREATE INDEX idx_increments_task ON increments(task_id, created_at);

-- Un problema detectado por el reviewer sobre un incremento concreto.
CREATE TABLE findings (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  increment_id   TEXT NOT NULL REFERENCES increments(id) ON DELETE CASCADE,
  source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  fix_task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  severity       TEXT NOT NULL,
  title          TEXT NOT NULL,
  detail         TEXT NOT NULL,
  resolution     TEXT NOT NULL,
  file_path      TEXT,
  line           INTEGER,
  status         TEXT NOT NULL DEFAULT 'open',
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  CHECK (severity IN ('blocker','major','minor')),
  CHECK (status IN ('open','fixed','dismissed'))
);

CREATE INDEX idx_findings_open   ON findings(project_id, status);
CREATE INDEX idx_findings_source ON findings(source_task_id, status);

-- Decisiones de producto del creador y del orquestador. Versionadas.
CREATE TABLE decisions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  supersedes_id TEXT REFERENCES decisions(id),
  decided_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_decisions_project ON decisions(project_id, revision);

-- Conversación del creador con el orquestador.
CREATE TABLE chat_messages (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_chat_project ON chat_messages(project_id, created_at);

-- Todo hecho relevante. Es la fuente del historial y de la web en vivo.
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  task_id    TEXT,
  run_id     TEXT,
  agent_id   TEXT,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_events_stream ON events(project_id, id);

-- Peticiones de autorización que el motor eleva al creador.
CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  request      TEXT NOT NULL,
  tool_name    TEXT,
  tool_input   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  responded_by TEXT,
  created_at   TEXT NOT NULL,
  responded_at TEXT,
  CHECK (status IN ('pending','granted','denied','expired'))
);

CREATE INDEX idx_approvals_pending ON approvals(status, created_at);
CREATE INDEX idx_approvals_task    ON approvals(task_id, status);

-- Avisos pendientes de entregar a una tarea en su siguiente ejecución (decisión D12).
CREATE TABLE notices (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_actor   TEXT NOT NULL,
  body         TEXT NOT NULL,
  delivered_at TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_notices_pending ON notices(task_id, delivered_at);

-- Último estado de consumo publicado por cada motor (apartado 11.6).
CREATE TABLE engine_usage (
  engine            TEXT PRIMARY KEY,
  status            TEXT NOT NULL,
  five_hour_util    REAL,
  five_hour_resets  TEXT,
  seven_day_util    REAL,
  seven_day_resets  TEXT,
  using_overage     INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'vigencia de asignaciones y mensajes entre agentes',
    sql: `
-- Vigencia de una asignación. Un worker que deja de renovarla se da por perdido.
CREATE TABLE leases (
  task_id    TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  worker_id  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL
);

CREATE INDEX idx_leases_expiry ON leases(expires_at);

-- Mensajes entre agentes: consultas, avisos, peticiones de apoyo y escalados.
CREATE TABLE agent_messages (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id     TEXT NOT NULL,
  from_agent_id TEXT NOT NULL REFERENCES agents(id),
  to_agent_id   TEXT REFERENCES agents(id),
  kind          TEXT NOT NULL,
  body          TEXT NOT NULL,
  task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  delivered_at  TEXT,
  created_at    TEXT NOT NULL,
  CHECK (kind IN ('question','notice','help_request','answer','escalation'))
);

CREATE INDEX idx_agent_messages_thread  ON agent_messages(project_id, thread_id, created_at);
CREATE INDEX idx_agent_messages_pending ON agent_messages(to_agent_id, delivered_at);
`,
  },
];
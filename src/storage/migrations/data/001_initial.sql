CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  pinned     INTEGER NOT NULL DEFAULT 0,
  sidebar_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE project_folders (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  -- NULL means this folder has never been primary; selection updates this timestamp.
  updated_at INTEGER,
  PRIMARY KEY (project_id, path)
);

CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  cwd                  TEXT NOT NULL,
  project_id           TEXT REFERENCES projects(id) ON DELETE SET NULL,
  pinned               INTEGER NOT NULL DEFAULT 0,
  archived_at          INTEGER,
  forked_from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  forked_from_turn_id  TEXT REFERENCES turns(id) ON DELETE SET NULL,
  last_viewed_at       INTEGER,
  last_activity_at     INTEGER NOT NULL DEFAULT 0,
  sidebar_order        INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  provider_id          TEXT,
  model_id             TEXT,
  reasoning_effort     TEXT NOT NULL DEFAULT 'off'
                       CHECK(reasoning_effort IN ('off', 'low', 'medium', 'high', 'max')),
  tts_enabled          INTEGER NOT NULL DEFAULT 0 CHECK(tts_enabled IN (0, 1)),
  permission_mode      TEXT NOT NULL DEFAULT 'default'
                       CHECK(permission_mode IN ('default', 'acceptEdits', 'bypassPermissions', 'plan'))
);

CREATE TABLE turns (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status               TEXT NOT NULL CHECK(status IN ('running','completed','failed','aborted')),
  trigger_type         TEXT NOT NULL DEFAULT 'userMessage'
                       CHECK(trigger_type IN ('userMessage','sessionContinuation')),
  provider_id          TEXT,
  model_id             TEXT,
  -- Resolved with provider_id/model_id during preparation; NULL until then.
  protocol             TEXT,
  -- Stable Character.name, used to select Relationship memory for this Turn.
  character_name       TEXT,
  iterations           INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  error_code           TEXT,
  error_message        TEXT,
  tts_enabled          INTEGER NOT NULL DEFAULT 0 CHECK(tts_enabled IN (0, 1))
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id     TEXT REFERENCES turns(id) ON DELETE SET NULL,
  role        TEXT NOT NULL CHECK(role IN ('user','assistant')),
  kind        TEXT NOT NULL DEFAULT 'normal'
              CHECK(kind IN ('normal','tool_results','summary','reminder','continuation')),
  blocks_json TEXT NOT NULL,
  interrupted INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  -- Summary coverage includes this message; history loading follows this boundary.
  summarized_through_message_id TEXT,
  summary_saved_tokens INTEGER
);

CREATE TABLE message_search_documents (
  message_id  TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  session_id  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  text        TEXT    NOT NULL,
  tokens      TEXT    NOT NULL
);

CREATE VIRTUAL TABLE message_search_fts USING fts5(
  tokens,
  message_id UNINDEXED,
  session_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 1'
);

CREATE TABLE tasks (
  id                   TEXT    PRIMARY KEY,
  session_id           TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  display_number       INTEGER NOT NULL CHECK (display_number > 0),
  subject              TEXT    NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  description          TEXT    NOT NULL CHECK (length(description) BETWEEN 1 AND 20000),
  active_form          TEXT    CHECK (active_form IS NULL OR length(active_form) BETWEEN 1 AND 200),
  status               TEXT    NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  created_by_turn_id   TEXT    NOT NULL REFERENCES turns(id) ON DELETE RESTRICT,
  completed_by_turn_id TEXT    REFERENCES turns(id) ON DELETE SET NULL,
  version              INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  CHECK (
    (
      status IN ('completed', 'cancelled')
      AND completed_by_turn_id IS NOT NULL
      AND completed_at IS NOT NULL
    )
    OR
    (
      status IN ('pending', 'in_progress')
      AND completed_by_turn_id IS NULL
      AND completed_at IS NULL
    )
  ),
  UNIQUE (session_id, display_number),
  UNIQUE (session_id, id)
);

CREATE TABLE task_context_state (
  session_id       TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  last_reminded_at INTEGER NOT NULL
);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed')),
  version INTEGER NOT NULL CHECK(version >= 1),
  reason TEXT CHECK(reason IN ('succeeded', 'failed', 'cancelled')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  feedback TEXT,
  CHECK (
    (status IN ('active', 'paused') AND reason IS NULL AND error IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND reason IS NOT NULL AND completed_at IS NOT NULL AND (
      (reason IN ('succeeded', 'cancelled') AND error IS NULL)
      OR (reason = 'failed' AND error IS NOT NULL)
    ))
  )
);

CREATE TABLE subagents (
  id                  TEXT    PRIMARY KEY,
  session_id          TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  description         TEXT,
  provider_id         TEXT,
  model_id            TEXT,
  status              TEXT    NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  title               TEXT,
  protocol            TEXT,
  permission_mode     TEXT CHECK (permission_mode IN ('default', 'acceptEdits', 'bypassPermissions', 'plan')),
  reasoning_effort    TEXT CHECK (reasoning_effort IN ('off', 'low', 'medium', 'high', 'max'))
);

CREATE TABLE subagent_runs (
  id                  TEXT PRIMARY KEY,
  subagent_id         TEXT NOT NULL REFERENCES subagents(id) ON DELETE CASCADE,
  parent_tool_call_id  TEXT UNIQUE,
  context_mode        TEXT NOT NULL CHECK (context_mode IN ('subagent', 'fork')),
  description         TEXT,
  provider_id         TEXT,
  model_id            TEXT,
  protocol            TEXT,
  permission_mode     TEXT CHECK (permission_mode IN ('default', 'acceptEdits', 'bypassPermissions', 'plan')),
  reasoning_effort    TEXT CHECK (reasoning_effort IN ('off', 'low', 'medium', 'high', 'max')),
  status              TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  error               TEXT,
  iterations          INTEGER,
  tool_call_count     INTEGER,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  final_text          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);

CREATE TABLE subagent_messages (
  id                            TEXT PRIMARY KEY,
  subagent_id                   TEXT NOT NULL REFERENCES subagents(id) ON DELETE CASCADE,
  -- Forked prefix messages belong to the identity but not to one of its Runs.
  run_id                        TEXT REFERENCES subagent_runs(id) ON DELETE CASCADE,
  role                          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  kind                          TEXT NOT NULL
                                CHECK (kind IN ('normal', 'tool_results', 'summary', 'continuation', 'reminder')),
  blocks_json                   TEXT NOT NULL,
  interrupted                   INTEGER NOT NULL DEFAULT 0,
  created_at                    INTEGER NOT NULL,
  summarized_through_message_id TEXT,
  summary_saved_tokens          INTEGER,
  provider_id                   TEXT,
  model_id                      TEXT,
  protocol                      TEXT
);

CREATE TABLE tool_executions (
  call_id        TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id        TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  tool_name      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN (
    'prepared', 'authorized', 'running', 'succeeded',
    'failed', 'cancelled', 'outcome_unknown'
  )),
  started_at     INTEGER,
  completed_at   INTEGER,
  version        INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  subagent_id    TEXT REFERENCES subagents(id) ON DELETE SET NULL
);

CREATE TABLE background_processes (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  origin_turn_id        TEXT REFERENCES turns(id) ON DELETE SET NULL,
  tool_call_id          TEXT REFERENCES tool_executions(call_id) ON DELETE SET NULL,
  command               TEXT NOT NULL,
  description           TEXT,
  cwd                   TEXT NOT NULL,
  status                TEXT NOT NULL CHECK(status IN (
                          'queued','running','completed','failed',
                          'timedOut','stopped','interrupted'
                        )),
  timeout_ms            INTEGER NOT NULL CHECK(timeout_ms > 0),
  version               INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  created_at            INTEGER NOT NULL,
  started_at            INTEGER,
  completed_at          INTEGER,
  exit_code             INTEGER,
  termination_reason    TEXT,
  stdout_bytes          INTEGER NOT NULL DEFAULT 0 CHECK(stdout_bytes >= 0),
  stderr_bytes          INTEGER NOT NULL DEFAULT 0 CHECK(stderr_bytes >= 0),
  output_truncated      INTEGER NOT NULL DEFAULT 0 CHECK(output_truncated IN (0, 1)),
  output_relative_path  TEXT NOT NULL
);

CREATE TABLE attachment_images (
  path       TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- NULL until a submitted Turn claims this managed file.
  turn_id    TEXT          REFERENCES turns(id)    ON DELETE CASCADE,
  -- Original filename for display. Clipboard images have no filename.
  name       TEXT,
  byte_size  INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE attachment_pasted_texts (
  path       TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id    TEXT          REFERENCES turns(id)    ON DELETE CASCADE,
  byte_size  INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE attachment_vision_descriptions_caches (
  path             TEXT PRIMARY KEY REFERENCES attachment_images(path) ON DELETE CASCADE,
  text             TEXT NOT NULL,
  byte_size        INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at       INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);

CREATE TABLE speech_outputs (
  turn_id       TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- A Turn can have several character versions; regenerating a path replaces that version.
  storage_path  TEXT NOT NULL PRIMARY KEY,
  mime_type     TEXT NOT NULL CHECK(mime_type = 'audio/wav'),
  byte_size     INTEGER NOT NULL CHECK(byte_size >= 0),
  duration_ms   INTEGER NOT NULL CHECK(duration_ms >= 0),
  created_at    INTEGER NOT NULL
);

CREATE TABLE usage_records (
  id                       TEXT PRIMARY KEY,
  session_id               TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id                  TEXT REFERENCES turns(id) ON DELETE CASCADE,
  provider_id              TEXT NOT NULL,
  model_id                 TEXT NOT NULL,
  capability               TEXT NOT NULL CHECK (capability IN ('llm','vision','embed','rerank','stt','tts')),
  status                   TEXT NOT NULL CHECK (status IN ('completed','failed','cancelled')),
  input_tokens             INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens            INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_input_tokens  INTEGER CHECK (cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0),
  cache_write_input_tokens INTEGER CHECK (cache_write_input_tokens IS NULL OR cache_write_input_tokens >= 0),
  quantity                 REAL CHECK (quantity IS NULL OR quantity >= 0),
  unit                     TEXT,
  duration_ms              INTEGER NOT NULL CHECK (duration_ms >= 0),
  error_code               TEXT,
  created_at               INTEGER NOT NULL,
  CHECK ((quantity IS NULL AND unit IS NULL) OR (quantity IS NOT NULL AND unit IS NOT NULL))
);

CREATE TABLE memory_jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK(kind IN (
                 'work_extraction',
                 'relationship_extraction',
                 'work_consolidation',
                 'relationship_consolidation',
                 'work_maintenance',
                 'relationship_maintenance'
               )),
  status       TEXT NOT NULL CHECK(status IN (
                 'pending', 'running', 'completed', 'failed'
               )),
  turn_id      TEXT REFERENCES turns(id) ON DELETE CASCADE,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  reminder_ignored INTEGER NOT NULL DEFAULT 0 CHECK (reminder_ignored IN (0, 1)),
  CHECK (
    (kind IN ('work_extraction', 'relationship_extraction') AND turn_id IS NOT NULL)
    OR
    (kind NOT IN ('work_extraction', 'relationship_extraction') AND turn_id IS NULL)
  )
);

CREATE TABLE memory_work_extractions (
  turn_id       TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  job_id        TEXT NOT NULL UNIQUE REFERENCES memory_jobs(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,
  integrated_at INTEGER
);

CREATE TABLE memory_relationship_extractions (
  turn_id        TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  job_id         TEXT NOT NULL UNIQUE REFERENCES memory_jobs(id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  character_name TEXT NOT NULL,
  content        TEXT NOT NULL,
  integrated_at  INTEGER
);

CREATE UNIQUE INDEX goals_one_unfinished_per_session
  ON goals(session_id) WHERE status IN ('active', 'paused');

CREATE INDEX goals_session_history ON goals(session_id, created_at DESC, id DESC);

CREATE INDEX idx_attachment_images_session
  ON attachment_images(session_id, created_at DESC);

CREATE INDEX idx_attachment_images_unsent
  ON attachment_images(session_id, created_at) WHERE turn_id IS NULL;

CREATE INDEX idx_attachment_pasted_texts_session
  ON attachment_pasted_texts(session_id, created_at DESC);

CREATE INDEX idx_attachment_pasted_texts_unsent
  ON attachment_pasted_texts(session_id, created_at) WHERE turn_id IS NULL;

CREATE INDEX idx_attachment_vision_descriptions_caches_lru
  ON attachment_vision_descriptions_caches(last_accessed_at ASC, path ASC);

CREATE INDEX idx_background_processes_recovery
  ON background_processes(status, created_at, id);

CREATE INDEX idx_background_processes_session
  ON background_processes(session_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX idx_memory_jobs_active_file_job
  ON memory_jobs(kind)
  WHERE kind IN (
    'work_consolidation', 'relationship_consolidation',
    'work_maintenance', 'relationship_maintenance'
  ) AND status IN ('pending', 'running');

CREATE INDEX idx_memory_jobs_created ON memory_jobs(created_at, id);

CREATE INDEX idx_memory_jobs_status_created
  ON memory_jobs(status, created_at, id);

CREATE INDEX idx_memory_jobs_turn
  ON memory_jobs(turn_id)
  WHERE turn_id IS NOT NULL;

CREATE UNIQUE INDEX idx_memory_jobs_turn_extraction
  ON memory_jobs(turn_id, kind)
  WHERE turn_id IS NOT NULL
    AND kind IN ('work_extraction', 'relationship_extraction');

CREATE INDEX idx_memory_jobs_unignored_failures ON memory_jobs(created_at, id)
  WHERE status = 'failed' AND reminder_ignored = 0;

CREATE INDEX idx_memory_relationship_extractions_unintegrated
  ON memory_relationship_extractions(integrated_at, job_id);

CREATE INDEX idx_memory_work_extractions_unintegrated
  ON memory_work_extractions(integrated_at, job_id);

CREATE INDEX idx_message_search_documents_session
  ON message_search_documents(session_id, created_at DESC, message_id DESC);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);

CREATE INDEX idx_messages_session_latest
  ON messages(session_id, created_at DESC, id DESC);

CREATE INDEX idx_messages_session_latest_summary
  ON messages(session_id, created_at DESC, id DESC)
  WHERE kind = 'summary';

CREATE INDEX idx_messages_summary_cursor
  ON messages(summarized_through_message_id)
  WHERE summarized_through_message_id IS NOT NULL;

CREATE INDEX idx_messages_turn    ON messages(turn_id);

CREATE UNIQUE INDEX idx_project_folders_primary
  ON project_folders(project_id) WHERE is_primary = 1;

CREATE INDEX idx_projects_sidebar_order
  ON projects(pinned DESC, sidebar_order DESC, id DESC);

CREATE INDEX idx_sessions_activity
  ON sessions(pinned DESC, last_activity_at DESC, id DESC);

CREATE INDEX idx_sessions_cwd
  ON sessions(cwd, last_activity_at DESC, id DESC);

CREATE INDEX idx_sessions_project
  ON sessions(project_id, last_activity_at DESC, id DESC)
  WHERE project_id IS NOT NULL;

CREATE INDEX idx_sessions_sidebar_order
  ON sessions(archived_at, pinned DESC, project_id, sidebar_order DESC, id DESC);

CREATE INDEX idx_speech_outputs_session ON speech_outputs(session_id, created_at DESC);

CREATE INDEX idx_speech_outputs_turn ON speech_outputs(turn_id);

CREATE INDEX idx_subagent_messages_run
  ON subagent_messages(run_id, created_at ASC, id ASC) WHERE run_id IS NOT NULL;

CREATE INDEX idx_subagent_messages_subagent
  ON subagent_messages(subagent_id, created_at ASC, id ASC);

CREATE UNIQUE INDEX idx_subagent_runs_running
  ON subagent_runs(subagent_id) WHERE status = 'running';

CREATE INDEX idx_subagent_runs_subagent
  ON subagent_runs(subagent_id, created_at DESC, id DESC);

CREATE INDEX idx_subagents_session
  ON subagents(session_id, created_at DESC, id DESC);

CREATE INDEX idx_subagents_session_updated ON subagents(session_id, updated_at DESC, id DESC);

CREATE INDEX idx_subagents_status
  ON subagents(status, created_at ASC, id ASC);

CREATE INDEX idx_tasks_session_status
  ON tasks(session_id, status, display_number ASC);

CREATE INDEX idx_tasks_session_updated
  ON tasks(session_id, updated_at DESC, id DESC);

CREATE INDEX idx_tool_executions_recovery
  ON tool_executions(status, updated_at, call_id);

CREATE INDEX idx_tool_executions_subagent
  ON tool_executions(subagent_id, created_at ASC, call_id ASC)
  WHERE subagent_id IS NOT NULL;

CREATE INDEX idx_tool_executions_turn
  ON tool_executions(turn_id, created_at, call_id);

CREATE INDEX idx_turns_running_by_session
  ON turns(session_id)
  WHERE status = 'running';

CREATE INDEX idx_turns_session ON turns(session_id, created_at);

CREATE INDEX idx_turns_session_latest
  ON turns(session_id, created_at DESC, id DESC);

CREATE INDEX idx_turns_status ON turns(status);

CREATE INDEX idx_usage_records_created ON usage_records(created_at, id);

CREATE INDEX idx_usage_records_session ON usage_records(session_id, created_at, id);

CREATE INDEX idx_usage_records_turn ON usage_records(turn_id, created_at, id);

CREATE TRIGGER message_search_fts_ad
AFTER DELETE ON message_search_documents BEGIN
  DELETE FROM message_search_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER message_search_fts_ai
AFTER INSERT ON message_search_documents BEGIN
  INSERT INTO message_search_fts(rowid, tokens, message_id, session_id)
  VALUES (NEW.rowid, NEW.tokens, NEW.message_id, NEW.session_id);
END;

CREATE TRIGGER message_search_fts_au
AFTER UPDATE OF tokens, session_id ON message_search_documents BEGIN
  DELETE FROM message_search_fts WHERE rowid = OLD.rowid;
  INSERT INTO message_search_fts(rowid, tokens, message_id, session_id)
  VALUES (NEW.rowid, NEW.tokens, NEW.message_id, NEW.session_id);
END;

CREATE TRIGGER messages_search_ai
AFTER INSERT ON messages
WHEN NEW.kind IN ('normal', 'summary') BEGIN
  INSERT INTO message_search_documents(message_id, session_id, created_at, text, tokens)
  VALUES (
    NEW.id,
    NEW.session_id,
    NEW.created_at,
    ema_message_search_text(NEW.blocks_json),
    ema_segment_fts(ema_message_search_text(NEW.blocks_json))
  );
END;

CREATE TRIGGER messages_search_au
AFTER UPDATE OF blocks_json, kind, session_id, created_at ON messages BEGIN
  DELETE FROM message_search_documents WHERE message_id = OLD.id;
  INSERT INTO message_search_documents(message_id, session_id, created_at, text, tokens)
  SELECT
    NEW.id,
    NEW.session_id,
    NEW.created_at,
    ema_message_search_text(NEW.blocks_json),
    ema_segment_fts(ema_message_search_text(NEW.blocks_json))
  WHERE NEW.kind IN ('normal', 'summary');
END;

CREATE TRIGGER sessions_model_pair_insert
BEFORE INSERT ON sessions
WHEN (NEW.provider_id IS NULL) <> (NEW.model_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'session model preference must contain both provider and model');
END;

CREATE TRIGGER sessions_model_pair_update
BEFORE UPDATE OF provider_id, model_id ON sessions
WHEN (NEW.provider_id IS NULL) <> (NEW.model_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'session model preference must contain both provider and model');
END;

CREATE TRIGGER trg_attachment_images_owner_insert
BEFORE INSERT ON attachment_images
WHEN NEW.turn_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: attachment_images.turn_id');
END;

CREATE TRIGGER trg_attachment_images_owner_update
BEFORE UPDATE OF session_id, turn_id ON attachment_images
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: attachment_images.session_id is immutable')
  END;
  SELECT CASE
    WHEN NEW.turn_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: attachment_images.turn_id')
  END;
END;

CREATE TRIGGER trg_attachment_pasted_texts_owner_insert
BEFORE INSERT ON attachment_pasted_texts
WHEN NEW.turn_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: attachment_pasted_texts.turn_id');
END;

CREATE TRIGGER trg_attachment_pasted_texts_owner_update
BEFORE UPDATE OF session_id, turn_id ON attachment_pasted_texts
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: attachment_pasted_texts.session_id is immutable')
  END;
  SELECT CASE
    WHEN NEW.turn_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: attachment_pasted_texts.turn_id')
  END;
END;

CREATE TRIGGER trg_background_processes_identity_update
BEFORE UPDATE OF id, session_id, origin_turn_id, tool_call_id, command, cwd, timeout_ms, output_relative_path
ON background_processes
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.session_id <> OLD.session_id
      OR NEW.origin_turn_id IS NOT OLD.origin_turn_id
      OR NEW.tool_call_id IS NOT OLD.tool_call_id
      OR NEW.command <> OLD.command
      OR NEW.cwd <> OLD.cwd
      OR NEW.timeout_ms <> OLD.timeout_ms
      OR NEW.output_relative_path <> OLD.output_relative_path
    THEN RAISE(ABORT, 'ownership_violation: background process identity is immutable')
  END;
END;

CREATE TRIGGER trg_background_processes_owner_insert
BEFORE INSERT ON background_processes
BEGIN
  SELECT CASE
    WHEN NEW.origin_turn_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.origin_turn_id AND t.session_id = NEW.session_id
    )
    THEN RAISE(ABORT, 'ownership_violation: background_processes.origin_turn_id')
  END;
  SELECT CASE
    WHEN NEW.tool_call_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM tool_executions e
       WHERE e.call_id = NEW.tool_call_id AND e.session_id = NEW.session_id
    )
    THEN RAISE(ABORT, 'ownership_violation: background_processes.tool_call_id')
  END;
END;

CREATE TRIGGER trg_messages_owner_insert
BEFORE INSERT ON messages
WHEN NEW.turn_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM turns t
    WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
 )
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: messages.turn_id');
END;

CREATE TRIGGER trg_messages_owner_update
BEFORE UPDATE OF session_id, turn_id ON messages
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: messages.session_id is immutable')
  END;
  SELECT CASE
    WHEN NEW.turn_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: messages.turn_id')
  END;
END;

CREATE TRIGGER trg_sessions_owner_update
BEFORE UPDATE OF id ON sessions
WHEN NEW.id <> OLD.id
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: sessions.id is immutable');
END;

CREATE TRIGGER trg_speech_outputs_owner_insert
BEFORE INSERT ON speech_outputs
WHEN NOT EXISTS (
  SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: speech_outputs.turn_id');
END;

CREATE TRIGGER trg_speech_outputs_owner_update
BEFORE UPDATE OF session_id, turn_id ON speech_outputs
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: speech_outputs.session_id is immutable')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: speech_outputs.turn_id')
  END;
END;

CREATE TRIGGER trg_subagent_messages_run_insert
BEFORE INSERT ON subagent_messages
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM subagent_runs r WHERE r.id = NEW.run_id AND r.subagent_id = NEW.subagent_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: subagent_messages.run_id');
END;

CREATE TRIGGER trg_subagent_messages_run_update
BEFORE UPDATE OF run_id, subagent_id ON subagent_messages
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM subagent_runs r WHERE r.id = NEW.run_id AND r.subagent_id = NEW.subagent_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: subagent_messages.run_id');
END;

CREATE TRIGGER trg_subagents_session_immutable
BEFORE UPDATE OF session_id ON subagents
WHEN NEW.session_id <> OLD.session_id
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: subagents.session_id is immutable');
END;

CREATE TRIGGER trg_tasks_owner_insert
BEFORE INSERT ON tasks
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM turns t
     WHERE t.id = NEW.created_by_turn_id
       AND t.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: tasks.created_by_turn_id') END;

  SELECT CASE WHEN NEW.completed_by_turn_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM turns t
     WHERE t.id = NEW.completed_by_turn_id
       AND t.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: tasks.completed_by_turn_id') END;
END;

CREATE TRIGGER trg_tasks_owner_update
BEFORE UPDATE OF session_id, created_by_turn_id, completed_by_turn_id ON tasks
BEGIN
  SELECT CASE WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: tasks.session_id is immutable') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM turns t
     WHERE t.id = NEW.created_by_turn_id
       AND t.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: tasks.created_by_turn_id') END;

  SELECT CASE WHEN NEW.completed_by_turn_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM turns t
     WHERE t.id = NEW.completed_by_turn_id
       AND t.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: tasks.completed_by_turn_id') END;
END;

CREATE TRIGGER trg_tool_executions_owner_insert
BEFORE INSERT ON tool_executions
WHEN NOT EXISTS (
  SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: tool_executions.turn_id');
END;

CREATE TRIGGER trg_tool_executions_owner_update
BEFORE UPDATE OF call_id, session_id, turn_id, tool_name
ON tool_executions
BEGIN
  SELECT CASE
    WHEN NEW.call_id <> OLD.call_id
      OR NEW.session_id <> OLD.session_id
      OR NEW.turn_id <> OLD.turn_id
      OR NEW.tool_name <> OLD.tool_name
    THEN RAISE(ABORT, 'ownership_violation: tool execution identity is immutable')
  END;
END;

CREATE TRIGGER trg_turns_model_pair_insert
BEFORE INSERT ON turns
WHEN (NEW.provider_id IS NULL) <> (NEW.model_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'turn model freeze must contain both provider and model');
END;

CREATE TRIGGER trg_turns_model_pair_update
BEFORE UPDATE OF provider_id, model_id ON turns
WHEN (NEW.provider_id IS NULL) <> (NEW.model_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'turn model freeze must contain both provider and model');
END;

CREATE TRIGGER trg_turns_owner_update
BEFORE UPDATE OF session_id ON turns
WHEN NEW.session_id <> OLD.session_id
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: turns.session_id is immutable');
END;

CREATE TRIGGER trg_usage_records_turn_session_insert
BEFORE INSERT ON usage_records
WHEN NEW.turn_id IS NOT NULL
 AND NEW.session_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
 )
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: usage_records.turn_id');
END;

CREATE TRIGGER trg_usage_records_turn_session_update
BEFORE UPDATE OF turn_id, session_id ON usage_records
WHEN NEW.turn_id IS NOT NULL
 AND NEW.session_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
 )
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: usage_records.turn_id');
END;

-- data.db 当前开发基线。
-- 由压缩前完整迁移链生成最终 Schema 后规范化导出。
-- 后续结构变更从 002_*.sql 开始追加。
CREATE TABLE agent_run_messages (
  id           TEXT    PRIMARY KEY,
  agent_run_id TEXT    NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  role         TEXT    NOT NULL CHECK (role IN ('assistant', 'tool_call', 'tool_result', 'reasoning')),
  -- 块身份：文本/思考/工具调用按 (agent_run_id, role, block_index) upsert；
  -- tool_result 一次调用一行，block_index 恒为 NULL（SQLite 唯一键不约束 NULL）。
  block_index  INTEGER,
  content_json TEXT    NOT NULL,
  sequence     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (agent_run_id, sequence),
  UNIQUE (agent_run_id, role, block_index)
);

CREATE TABLE agent_runs (
  id                  TEXT    PRIMARY KEY,
  session_id          TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_turn_id      TEXT    NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  parent_agent_run_id TEXT    REFERENCES agent_runs(id) ON DELETE SET NULL,
  context_mode        TEXT    NOT NULL CHECK (context_mode IN ('subagent', 'fork')),
  description         TEXT,
  provider_id         TEXT,
  model_id            TEXT,
  status              TEXT    NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  error               TEXT,
  iterations          INTEGER,
  tool_call_count     INTEGER,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
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
  output_relative_path  TEXT NOT NULL,
  completion_claimed_at INTEGER,
  continuation_turn_id  TEXT,
  model_notified_at     INTEGER
);

CREATE TABLE memory_jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK(kind IN (
                 'work_extraction',
                 'relationship_extraction',
                 'work_consolidation',
                 'relationship_consolidation',
                 'clear_memory',
                 'storage_cleanup'
               )),
  status       TEXT NOT NULL CHECK(status IN (
                 'pending', 'running', 'completed', 'failed', 'cancelled'
               )),
  turn_id      TEXT REFERENCES turns(id) ON DELETE CASCADE,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  heartbeat_at INTEGER,
  finished_at  INTEGER,
  CHECK (
    (kind IN ('work_extraction', 'relationship_extraction') AND turn_id IS NOT NULL)
    OR
    (kind NOT IN ('work_extraction', 'relationship_extraction') AND turn_id IS NULL)
  )
);

CREATE TABLE memory_extraction_results (
  job_id        TEXT PRIMARY KEY REFERENCES memory_jobs(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,
  integrated_at INTEGER
);

CREATE TABLE memory_job_paths (
  job_id        TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  operation     TEXT NOT NULL CHECK(operation IN (
                  'write_file', 'delete_file', 'delete_tree'
                )),
  PRIMARY KEY(job_id, relative_path)
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

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id     TEXT REFERENCES turns(id) ON DELETE SET NULL,
  role        TEXT NOT NULL CHECK(role IN ('system','user','assistant')),
  kind        TEXT NOT NULL DEFAULT 'normal'
              CHECK(kind IN ('normal','tool_results','summary','reminder')),
  blocks_json TEXT NOT NULL,
  interrupted INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  -- 仅 kind='summary' 行非空：摘要覆盖截止点（含该消息），历史边界按它切。
  summarized_through_message_id TEXT);

CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  workspace_root       TEXT,
  project_id           TEXT REFERENCES projects(id) ON DELETE SET NULL,
  pinned               INTEGER NOT NULL DEFAULT 0,
  archived_at          INTEGER,
  forked_from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  forked_from_turn_id  TEXT REFERENCES turns(id) ON DELETE SET NULL,
  last_viewed_at       INTEGER,
  last_activity_at     INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  provider_id   TEXT,
  model_id             TEXT,
  execution_profile    TEXT NOT NULL DEFAULT 'chat'
                       CHECK(execution_profile IN ('chat', 'work')),
  narrative_policy     TEXT NOT NULL DEFAULT 'auto'
                       CHECK(narrative_policy IN ('auto', 'always', 'off'))
);

CREATE TABLE task_context_state (
  session_id       TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  last_reminded_at INTEGER NOT NULL
);

-- 项目是实体：可编辑名称、多源文件夹、恰好一个主文件夹。
CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- updated_at 只在"设为主要"时写入（NULL=从未当过主），按 updated_at DESC 排序主文件夹永远第一。
CREATE TABLE project_folders (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  PRIMARY KEY (project_id, path)
);

-- 至多一个主文件夹（"至少一个"由 repo 拒绝末位删除保证）。
CREATE UNIQUE INDEX idx_project_folders_primary
  ON project_folders(project_id) WHERE is_primary = 1;

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
  updated_at     INTEGER NOT NULL
, agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL);

-- 附件账本:只有 Ema 落盘的东西入库(图片受管副本、粘贴文本 txt)。
-- 拖入的用户文件不入库,消息块只记它的原路径。
-- turn_id NULL = 粘贴时已落盘入账但还没被任何已发 Turn 消费;发送时盖章。
CREATE TABLE attachment_images (
  path       TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id    TEXT          REFERENCES turns(id)    ON DELETE CASCADE,
  -- 拖入图片的原文件名,供 UI 展示;剪贴板图片没有原生名存 NULL。
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

-- Vision 描述缓存:path 即图片受管副本路径,可再生,按 LRU 与容量预算清扫。
CREATE TABLE attachment_vision_descriptions_caches (
  path             TEXT PRIMARY KEY REFERENCES attachment_images(path) ON DELETE CASCADE,
  text             TEXT NOT NULL,
  byte_size        INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at       INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);

-- Speech 包拥有的 TTS 输出：整轮合并音频与逐句分段。
CREATE TABLE speech_outputs (
  turn_id       TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  storage_path  TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  duration_ms   INTEGER,
  segment_count INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE speech_segments (
  id             TEXT PRIMARY KEY,
  turn_id        TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sentence_index INTEGER NOT NULL,
  storage_path   TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  duration_ms    INTEGER,
  text           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE(turn_id, sentence_index)
);

-- Turn 排序、分页、时长与 fork 截断一律使用 created_at（创建即启动，无独立 pending 态）。
CREATE TABLE turns (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status               TEXT NOT NULL CHECK(status IN ('running','completed','failed','aborted')),
  trigger_type         TEXT NOT NULL DEFAULT 'userMessage'
                       CHECK(trigger_type IN ('userMessage','backgroundProcessCompleted')),
  execution_profile    TEXT NOT NULL DEFAULT 'chat'
                       CHECK(execution_profile IN ('chat','work')),
  narrative_policy     TEXT NOT NULL DEFAULT 'auto'
                       CHECK(narrative_policy IN ('auto','always','off')),
  provider_id   TEXT,
  model_id             TEXT,
  -- prepare 解析出的实际调用协议（与 provider_id/model_id 同生命周期，setModel 回填前为 null）。
  protocol             TEXT,
  -- 本 Turn 激活角色的磁盘目录名（Character.directoryName 快照）；Memory relationship 提取经 turnId 回读。
  character_directory_name TEXT,
  iterations           INTEGER NOT NULL DEFAULT 0,
  usage_input_tokens   INTEGER NOT NULL DEFAULT 0,
  usage_output_tokens  INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  error_code           TEXT,
  error_message        TEXT
);

CREATE TABLE "usage_records" (
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

CREATE INDEX idx_agent_runs_parent_run
  ON agent_runs(parent_agent_run_id);

CREATE INDEX idx_agent_runs_parent_turn
  ON agent_runs(parent_turn_id, created_at ASC, id ASC);

CREATE INDEX idx_agent_runs_session
  ON agent_runs(session_id, created_at DESC, id DESC);

CREATE INDEX idx_agent_runs_status
  ON agent_runs(status, created_at ASC, id ASC);

CREATE INDEX idx_attachment_vision_descriptions_caches_lru
  ON attachment_vision_descriptions_caches(last_accessed_at ASC, path ASC);

CREATE INDEX idx_speech_outputs_session ON speech_outputs(session_id, created_at DESC);

CREATE INDEX idx_speech_seg_session ON speech_segments(session_id, created_at DESC);

CREATE INDEX idx_speech_seg_turn    ON speech_segments(turn_id, sentence_index);

CREATE INDEX idx_background_processes_completion
  ON background_processes(session_id, model_notified_at, completion_claimed_at, completed_at, id);

CREATE INDEX idx_background_processes_continuation
  ON background_processes(continuation_turn_id, id)
  WHERE continuation_turn_id IS NOT NULL;

CREATE INDEX idx_background_processes_recovery
  ON background_processes(status, created_at, id);

CREATE INDEX idx_background_processes_session
  ON background_processes(session_id, created_at DESC, id DESC);

CREATE INDEX idx_memory_jobs_status_created
  ON memory_jobs(status, created_at, id);

CREATE INDEX idx_memory_jobs_turn
  ON memory_jobs(turn_id)
  WHERE turn_id IS NOT NULL;

CREATE UNIQUE INDEX idx_memory_jobs_active_extraction
  ON memory_jobs(turn_id, kind)
  WHERE turn_id IS NOT NULL
    AND status IN ('pending', 'running', 'completed');

CREATE INDEX idx_memory_extraction_results_unintegrated
  ON memory_extraction_results(integrated_at, job_id);

CREATE INDEX idx_memory_job_paths_path
  ON memory_job_paths(relative_path, job_id);

CREATE INDEX idx_message_search_documents_session
  ON message_search_documents(session_id, created_at DESC, message_id DESC);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);

CREATE INDEX idx_messages_session_latest
  ON messages(session_id, created_at DESC, id DESC);

CREATE INDEX idx_messages_session_latest_summary
  ON messages(session_id, created_at DESC, id DESC)
  WHERE kind = 'summary';

CREATE INDEX idx_messages_turn    ON messages(turn_id);

-- 摘要覆盖截止游标：loadHistory 按游标反查消息、Fork/Backup 重映射游标都用它。
CREATE INDEX idx_messages_summary_cursor
  ON messages(summarized_through_message_id)
  WHERE summarized_through_message_id IS NOT NULL;

CREATE INDEX idx_sessions_activity
  ON sessions(pinned DESC, last_activity_at DESC, id DESC);

CREATE INDEX idx_sessions_workspace
  ON sessions(workspace_root, last_activity_at DESC, id DESC)
  WHERE workspace_root IS NOT NULL;

CREATE INDEX idx_sessions_project
  ON sessions(project_id, last_activity_at DESC, id DESC)
  WHERE project_id IS NOT NULL;

CREATE INDEX idx_tasks_session_status
  ON tasks(session_id, status, display_number ASC);

CREATE INDEX idx_tasks_session_updated
  ON tasks(session_id, updated_at DESC, id DESC);

CREATE INDEX idx_tool_executions_agent_run
  ON tool_executions(agent_run_id, created_at ASC, call_id ASC)
  WHERE agent_run_id IS NOT NULL;

CREATE INDEX idx_tool_executions_recovery
  ON tool_executions(status, updated_at, call_id);

CREATE INDEX idx_tool_executions_turn
  ON tool_executions(turn_id, created_at, call_id);

CREATE INDEX idx_attachment_images_session
  ON attachment_images(session_id, created_at DESC);

-- 孤儿清扫:贴了没发的残留按 Session 维度一条查询。
CREATE INDEX idx_attachment_images_unsent
  ON attachment_images(session_id, created_at) WHERE turn_id IS NULL;

CREATE INDEX idx_attachment_pasted_texts_session
  ON attachment_pasted_texts(session_id, created_at DESC);

CREATE INDEX idx_attachment_pasted_texts_unsent
  ON attachment_pasted_texts(session_id, created_at) WHERE turn_id IS NULL;

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

CREATE TRIGGER trg_agent_runs_owner_insert
BEFORE INSERT ON agent_runs
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM turns t
    WHERE t.id = NEW.parent_turn_id
      AND t.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: agent_runs.parent_turn_id') END;

  SELECT CASE WHEN NEW.parent_agent_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_runs p
    WHERE p.id = NEW.parent_agent_run_id
      AND p.session_id = NEW.session_id
      AND p.parent_turn_id = NEW.parent_turn_id
  ) THEN RAISE(ABORT, 'ownership_violation: agent_runs.parent_agent_run_id') END;
END;

CREATE TRIGGER trg_agent_runs_owner_update
BEFORE UPDATE OF session_id, parent_turn_id, parent_agent_run_id ON agent_runs
BEGIN
  SELECT CASE WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: agent_runs.session_id is immutable') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM turns t
    WHERE t.id = NEW.parent_turn_id
      AND t.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: agent_runs.parent_turn_id') END;

  SELECT CASE WHEN NEW.parent_agent_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_runs p
    WHERE p.id = NEW.parent_agent_run_id
      AND p.session_id = NEW.session_id
      AND p.parent_turn_id = NEW.parent_turn_id
  ) THEN RAISE(ABORT, 'ownership_violation: agent_runs.parent_agent_run_id') END;
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

CREATE TRIGGER trg_speech_segments_owner_insert
BEFORE INSERT ON speech_segments
WHEN NOT EXISTS (
  SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: speech_segments.turn_id');
END;

CREATE TRIGGER trg_speech_segments_owner_update
BEFORE UPDATE OF session_id, turn_id ON speech_segments
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: speech_segments.session_id is immutable')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: speech_segments.turn_id')
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

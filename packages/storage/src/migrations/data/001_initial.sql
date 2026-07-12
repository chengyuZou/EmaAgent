-- ════════════════════════════════════════════════════════════════════════════
-- DATA 流--每个 workspace(dataDir)一个 data.db。Session / Turn / Message
-- / per-session Memory / 音频 / Artifact / Agent task。KB *文档* 存在于
-- 每个 KB 独立的 kb.db(kb 流)中;只有 kb_activations(session->KB 使用记录)留在这。
--
-- 合并后的初始 schema(替代旧的增量迁移 001–016)。
-- ════════════════════════════════════════════════════════════════════════════

-- ── Session / branch / Turn / Message ──────────────────────────────────────────

CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  character_card_id    TEXT NOT NULL DEFAULT 'ema',
  workspace_root       TEXT,
  last_mode            TEXT,
  group_label          TEXT,
  pinned               INTEGER NOT NULL DEFAULT 0,
  pinned_at            INTEGER,
  archived_at          INTEGER,
  parent_session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  active_branch_id     TEXT REFERENCES branches(id),
  last_viewed_at       INTEGER,
  last_activity_at     INTEGER NOT NULL DEFAULT 0,
  meta_json            TEXT NOT NULL DEFAULT '{}',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX idx_sessions_list ON sessions(pinned DESC, group_label, last_activity_at DESC);

CREATE TABLE branches (
  id                TEXT    PRIMARY KEY,
  session_id        TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_branch_id  TEXT    REFERENCES branches(id),
  fork_from_turn_id TEXT    REFERENCES turns(id),
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_branches_session   ON branches(session_id);
CREATE INDEX idx_branches_fork_turn ON branches(fork_from_turn_id);

CREATE TABLE turns (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  branch_id            TEXT REFERENCES branches(id),
  mode                 TEXT NOT NULL CHECK(mode IN ('chat','narrative','agent')),
  status               TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','aborted')),
  user_input           TEXT NOT NULL,
  started_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  error_code           TEXT,
  error_message        TEXT,
  iterations           INTEGER NOT NULL DEFAULT 0,
  usage_input_tokens   INTEGER NOT NULL DEFAULT 0,
  usage_output_tokens  INTEGER NOT NULL DEFAULT 0,
  meta_json            TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_turns_session ON turns(session_id, started_at);
CREATE INDEX idx_turns_status  ON turns(status);
CREATE INDEX idx_turns_branch  ON turns(branch_id);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id     TEXT REFERENCES turns(id) ON DELETE SET NULL,
  role        TEXT NOT NULL CHECK(role IN ('system','user','assistant')),
  kind        TEXT NOT NULL DEFAULT 'normal'
              CHECK(kind IN ('normal','context','tool_results','summary','persona_reminder')),
  blocks_json TEXT NOT NULL,
  interrupted INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  meta_json   TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);
CREATE INDEX idx_messages_turn    ON messages(turn_id);

CREATE TABLE pending_fragments (
  id         TEXT    PRIMARY KEY,
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id    TEXT    NOT NULL REFERENCES turns(id)    ON DELETE CASCADE,
  role       TEXT    NOT NULL CHECK(role IN ('user', 'assistant')),
  content    TEXT    NOT NULL,
  at         INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_pending_fragments_session ON pending_fragments(session_id, created_at ASC);

-- ── Per-session Memory(L1 notes + 队列 + 召回状态)───────────────────────────────

CREATE TABLE session_notes (
  session_id            TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  body                  TEXT NOT NULL DEFAULT '',
  last_message_id       TEXT,
  tokens_at_last_update INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE memory_tasks (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK(kind IN ('extraction','maintenance','embedding_refresh','consolidation')),
  status       TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_memorytasks_status_created ON memory_tasks(status, created_at);
CREATE INDEX idx_memorytasks_session        ON memory_tasks(session_id);

CREATE TABLE memory_session_state (
  session_id     TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  surfaced_json  TEXT NOT NULL DEFAULT '{}',
  overrides_json TEXT NOT NULL DEFAULT '{}'
);

-- ── 音频(TTS 分段 + 合并)─────────────────────────────────────────────────────────

CREATE TABLE turn_audio_segments (
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

CREATE INDEX idx_audio_seg_turn    ON turn_audio_segments(turn_id, sentence_index);
CREATE INDEX idx_audio_seg_session ON turn_audio_segments(session_id, created_at DESC);

CREATE TABLE turn_audio_merged (
  turn_id       TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  storage_path  TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  duration_ms   INTEGER,
  segment_count INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_audio_merged_session ON turn_audio_merged(session_id, created_at DESC);

-- ── Turn attachment(per-turn 本地文件引用)──────────────────────────────────────

CREATE TABLE turn_attachments (
  id         TEXT    PRIMARY KEY,
  turn_id    TEXT    NOT NULL REFERENCES turns(id)    ON DELETE CASCADE,
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  mime       TEXT    NOT NULL,
  size       INTEGER NOT NULL,
  mtime      INTEGER NOT NULL,
  local_path TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_turn_attachments_turn    ON turn_attachments(turn_id);
CREATE INDEX idx_turn_attachments_session ON turn_attachments(session_id, created_at DESC);

-- ── Artifact ──────────────────────────────────────────────────────────────────

CREATE TABLE artifacts (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id          TEXT REFERENCES turns(id) ON DELETE SET NULL,
  type             TEXT NOT NULL,
  title            TEXT NOT NULL,
  content          TEXT,
  content_location TEXT NOT NULL CHECK(content_location IN ('inline','file')),
  content_path     TEXT,
  meta_json        TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  applied_at       INTEGER,
  rejected_at      INTEGER
);

CREATE INDEX idx_artifacts_session ON artifacts(session_id, created_at DESC);
CREATE INDEX idx_artifacts_turn    ON artifacts(turn_id);

-- ── 权限授权 / telemetry / usage ──────────────────────────────────────────────────

CREATE TABLE permission_grants (
  id           TEXT PRIMARY KEY,
  tool_pattern TEXT NOT NULL,
  arg_matcher  TEXT,
  effect       TEXT NOT NULL CHECK(effect IN ('allow','ask','forbidden')),
  scope        TEXT NOT NULL CHECK(scope IN ('session','persistent')),
  session_id   TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK(source IN ('user','project','default')),
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_grants_tool ON permission_grants(tool_pattern);

CREATE TABLE telemetry_events (
  id           TEXT PRIMARY KEY,
  session_id   TEXT,
  turn_id      TEXT,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_telemetry_kind ON telemetry_events(kind, created_at);

CREATE TABLE turn_usage (
  turn_id       TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  llm_provider  TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd      REAL NOT NULL,
  duration_ms   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

-- ── Agent task(SQL-backed;替代 JSONL transcript)─────────────────────────────────

CREATE TABLE agent_tasks (
  id                     TEXT    PRIMARY KEY,
  session_id             TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id                TEXT,
  parent_id              TEXT,
  status                 TEXT    NOT NULL DEFAULT 'running'
                                 CHECK (status IN ('running','waiting_user','completed','failed','cancelled')),
  pending_prompt_id      TEXT,
  pending_questions_json TEXT,
  error                  TEXT,
  iterations             INTEGER,
  input_tokens           INTEGER,
  output_tokens          INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX idx_agent_tasks_session ON agent_tasks(session_id, created_at DESC);
CREATE INDEX idx_agent_tasks_parent  ON agent_tasks(parent_id);
CREATE INDEX idx_agent_tasks_status  ON agent_tasks(status);

CREATE TABLE agent_task_messages (
  id           TEXT    PRIMARY KEY,
  task_id      TEXT    NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  role         TEXT    NOT NULL CHECK (role IN ('assistant','tool_call','tool_result','reasoning')),
  content_json TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_atm_task_created ON agent_task_messages(task_id, created_at ASC);

-- ── KB activation(session -> KB 文档使用记录)──────────────────────────────────────
-- 留在 data.db(session 作用域)。kb_id + asset_id 是指向各自 KB kb.db 的裸引用
-- (无 FK--跨库)。session_id 保留 FK。

CREATE TABLE kb_activations (
  id          TEXT    PRIMARY KEY,
  call_id     TEXT    NOT NULL,
  kb_id       TEXT    NOT NULL,
  asset_id    TEXT    NOT NULL,
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_kb_act_session ON kb_activations(session_id);
CREATE INDEX idx_kb_act_asset   ON kb_activations(kb_id, asset_id);
CREATE INDEX idx_kb_act_call    ON kb_activations(call_id);

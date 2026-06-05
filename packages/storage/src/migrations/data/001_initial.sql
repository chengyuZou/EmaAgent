-- ── Data DB schema ────────────────────────────────────────────────────────────
--
-- data.db lives in `{dataDir}/data.db`.
-- "dataDir" = where the user chose to store their data, not a workspace
-- boundary (workspace = Permission/sandbox scope, stored in sessions.workspace_roots_json).
--
-- Contains everything scoped to this data directory:
--   sessions / turns / messages
--   memory L1 (session notes — per-session rolling summary)
--   background tasks queue
--   audio metadata (files at sessions/<sessionId>/audio/)
--   attachments + artifacts metadata (files at sessions/<sessionId>/artifacts/)
--   permission grants
--   telemetry + usage
--
-- Memory L0 (entity graph) and L2 (episodic items) live in profile.db
-- because they are global memories that must survive dataDir switches.
--
-- Development note: single consolidated migration. New schema changes are
-- made here directly during development.

-- ============ Sessions / turns / messages ============

CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  character_card_id    TEXT NOT NULL DEFAULT 'ema',
  workspace_roots_json TEXT NOT NULL DEFAULT '[]',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  archived_at          INTEGER,
  pinned               INTEGER NOT NULL DEFAULT 0,
  pinned_at            INTEGER,
  group_label          TEXT,
  parent_session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  last_mode            TEXT,
  last_sub_mode        TEXT,
  meta_json            TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_sessions_list ON sessions(pinned DESC, group_label, updated_at DESC);

-- ── Pending extraction fragments ──────────────────────────────────────────────
--
-- Accumulates raw conversation text (user + assistant turns) that has not yet
-- been processed by the extraction LLM. Fragments are appended onTurnEnd and
-- consumed (then deleted) by the background extraction pipeline.
--
-- Separated from sessions so we can:
--   • query "which sessions have pending work" with a simple SELECT DISTINCT
--   • delete individual fragments without rewriting the whole sessions row
--   • track per-fragment turn lineage for idempotent retry logic
--
CREATE TABLE pending_fragments (
  id         TEXT    PRIMARY KEY,
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id    TEXT    NOT NULL REFERENCES turns(id)    ON DELETE CASCADE,
  role       TEXT    NOT NULL CHECK(role IN ('user', 'assistant')),
  content    TEXT    NOT NULL,
  at         INTEGER NOT NULL,   -- unix ms: when this side of the turn happened
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_fragments_session ON pending_fragments(session_id, created_at ASC);

CREATE TABLE turns (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  mode                 TEXT NOT NULL CHECK(mode IN ('chat','narrative','agent')),
  agent_sub_mode       TEXT CHECK(agent_sub_mode IN ('plan','debug','full')),
  status               TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','aborted')),
  user_input           TEXT NOT NULL,
  started_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  error_code           TEXT,
  error_message        TEXT,
  iterations           INTEGER NOT NULL DEFAULT 0,
  usage_input_tokens   INTEGER NOT NULL DEFAULT 0,
  usage_output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd             REAL NOT NULL DEFAULT 0,
  meta_json            TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_turns_session ON turns(session_id, started_at);
CREATE INDEX idx_turns_status  ON turns(status);

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

-- ============ Memory Layer 1: session notes ============
--
-- Per-session rolling summary. Scoped to this dataDir; unlike L0/L2, these
-- summaries describe what was discussed in a specific session, not global facts.

CREATE TABLE session_notes (
  session_id             TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  body                   TEXT NOT NULL DEFAULT '',
  last_message_id        TEXT,
  tokens_at_last_update  INTEGER NOT NULL DEFAULT 0,
  updated_at             INTEGER NOT NULL
);

-- ============ Background tasks ============

CREATE TABLE background_tasks (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK(kind IN (
                  'extraction', 'consolidation', 'compaction',
                  'embedding_refresh',
                  'subagent_run',
                  'audio_merge', 'audio_cleanup'
                )),
  status        TEXT NOT NULL CHECK(status IN (
                  'pending', 'running', 'completed', 'failed'
                )),
  session_id    TEXT,
  payload_json  TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_bgtasks_status_created ON background_tasks(status, created_at);
CREATE INDEX idx_bgtasks_session        ON background_tasks(session_id);

-- ============ Audio (TTS output) ============
--
-- Files live at: {dataDir}/sessions/{session_id}/audio/segments/{turn_id}/{n}.{ext}
--                {dataDir}/sessions/{session_id}/audio/merged/{turn_id}.{ext}
-- storage_path is relative to dataDir.

CREATE TABLE turn_audio_segments (
  id              TEXT PRIMARY KEY,
  turn_id         TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sentence_index  INTEGER NOT NULL,
  storage_path    TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  byte_size       INTEGER NOT NULL,
  duration_ms     INTEGER,
  text            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE(turn_id, sentence_index)
);
CREATE INDEX idx_audio_seg_turn    ON turn_audio_segments(turn_id, sentence_index);
CREATE INDEX idx_audio_seg_session ON turn_audio_segments(session_id, created_at DESC);

CREATE TABLE turn_audio_merged (
  turn_id        TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  storage_path   TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  duration_ms    INTEGER,
  segment_count  INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_audio_merged_session ON turn_audio_merged(session_id, created_at DESC);

-- ============ Attachments ============

CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('pending','indexed','failed')),
  created_at   INTEGER NOT NULL,
  meta_json    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE attachment_chunks (
  id            TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  text          TEXT NOT NULL,
  embedding     BLOB,
  meta_json     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_chunks_attachment ON attachment_chunks(attachment_id, chunk_index);

-- ============ Artifacts ============
--
-- Files > 64 KB live at: {dataDir}/sessions/{session_id}/artifacts/{id}
-- content_path is relative to dataDir.

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

-- ============ Permission grants ============

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

-- ============ Telemetry + usage ============

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

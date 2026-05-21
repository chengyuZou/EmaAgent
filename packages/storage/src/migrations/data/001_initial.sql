-- ── Data DB initial schema ───────────────────────────────────────────────────
--
-- data.db lives in `{dataDir}/data.db` and holds everything that's specific
-- to the active workspace context:
--
--   - sessions / turns / messages
--   - memory (Layer 0 entity graph, Layer 1 notes, Layer 2 items)
--   - background tasks queue
--   - audio segments + merged
--   - attachments + artifacts
--   - permission grants (session-scoped)
--   - telemetry + usage
--
-- Switching dataDir = switching all of this in one shot. Profile (providers,
-- bindings, settings, cards) stays the same across dirs.

-- ============ Sessions / turns / messages ============

CREATE TABLE sessions (
  id                     TEXT PRIMARY KEY,
  title                  TEXT NOT NULL,
  character_card_id      TEXT NOT NULL DEFAULT 'ema',
  workspace_roots_json   TEXT NOT NULL DEFAULT '[]',
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  archived_at            INTEGER,
  meta_json              TEXT NOT NULL DEFAULT '{}',
  pending_fragments_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);

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
              CHECK(kind IN ('normal','context','tool_results','compact_boundary','summary','persona_reminder')),
  blocks_json TEXT NOT NULL,
  interrupted INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  meta_json   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_messages_session ON messages(session_id, created_at);
CREATE INDEX idx_messages_turn    ON messages(turn_id);

-- ============ Memory Layer 0: entity graph ============

CREATE TABLE memory_nodes (
  id                     TEXT PRIMARY KEY,
  label                  TEXT NOT NULL,
  node_type              TEXT NOT NULL CHECK(node_type IN (
                           'user_fact', 'entity', 'event',
                           'emotion', 'preference', 'relationship'
                         )),
  description            TEXT NOT NULL,
  embedding              BLOB,
  embedding_provider_id  TEXT,
  embedding_model        TEXT,
  embedding_dim          INTEGER,
  importance             INTEGER NOT NULL DEFAULT 50
                         CHECK(importance BETWEEN 0 AND 100),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  last_referenced_at     INTEGER NOT NULL,
  meta_json              TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX idx_memory_nodes_label_type ON memory_nodes(label, node_type);
CREATE INDEX        idx_memory_nodes_type       ON memory_nodes(node_type);
CREATE INDEX        idx_memory_nodes_lastref    ON memory_nodes(last_referenced_at DESC);
CREATE INDEX        idx_memory_nodes_importance ON memory_nodes(importance DESC);

CREATE TABLE memory_edges (
  id                  TEXT PRIMARY KEY,
  from_node_id        TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  to_node_id          TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  relation            TEXT NOT NULL,
  mention_count       INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  last_referenced_at  INTEGER NOT NULL,
  UNIQUE(from_node_id, to_node_id, relation)
);
CREATE INDEX idx_memory_edges_from ON memory_edges(from_node_id);
CREATE INDEX idx_memory_edges_to   ON memory_edges(to_node_id);

CREATE TABLE memory_node_lazy_updates (
  id                 TEXT PRIMARY KEY,
  node_id            TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  fragment           TEXT NOT NULL,
  source_session_id  TEXT,
  source_turn_id     TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_lazy_updates_node ON memory_node_lazy_updates(node_id, created_at);

-- ============ Memory Layer 2: episodic items ============

CREATE TABLE memory_items (
  id                     TEXT PRIMARY KEY,
  kind                   TEXT NOT NULL CHECK(kind IN ('user','feedback','project','reference')),
  title                  TEXT NOT NULL,
  body                   TEXT NOT NULL,
  embedding              BLOB,
  source_session_id      TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  source_turn_id         TEXT REFERENCES turns(id) ON DELETE SET NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  expires_at             INTEGER,
  importance             INTEGER NOT NULL DEFAULT 50,
  meta_json              TEXT NOT NULL DEFAULT '{}',
  modes_json             TEXT NOT NULL DEFAULT '["chat","agent"]',
  last_referenced_at     INTEGER NOT NULL DEFAULT 0,
  embedding_provider_id  TEXT,
  embedding_model        TEXT,
  embedding_dim          INTEGER
);
CREATE INDEX idx_memory_items_kind       ON memory_items(kind);
CREATE INDEX idx_memory_items_updated    ON memory_items(updated_at DESC);
CREATE INDEX idx_memory_items_importance ON memory_items(importance DESC);
CREATE INDEX idx_memory_items_lastref    ON memory_items(last_referenced_at DESC);

-- ============ Memory Layer 1: session notes ============

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

CREATE TABLE turn_audio_segments (
  id              TEXT PRIMARY KEY,
  turn_id         TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sentence_index  INTEGER NOT NULL,
  storage_path    TEXT NOT NULL,      -- relative to dataDir
  mime_type       TEXT NOT NULL,
  byte_size       INTEGER NOT NULL,
  duration_ms     INTEGER,
  text            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE(turn_id, sentence_index)
);
CREATE INDEX idx_audio_seg_turn    ON turn_audio_segments(turn_id, sentence_index);
CREATE INDEX idx_audio_seg_session ON turn_audio_segments(session_id, created_at DESC);
CREATE INDEX idx_audio_seg_ttl     ON turn_audio_segments(created_at);

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

-- ============ Artifact ============

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

-- ============ Permission grants (session-scoped) ============

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
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  turn_id     TEXT,
  kind        TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_telemetry_kind ON telemetry_events(kind, created_at);

CREATE TABLE turn_usage (
  turn_id      TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  llm_provider TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd     REAL NOT NULL,
  duration_ms  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

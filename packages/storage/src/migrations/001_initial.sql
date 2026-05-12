-- Migration 001: initial schema
-- Applied via PRAGMA user_version mechanism in MigrationsRunner

-- ============ Sessions & Messages ============

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  character_card_id    TEXT NOT NULL DEFAULT 'ema',
  workspace_roots_json TEXT NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived_at       INTEGER,
  meta_json         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS turns (
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
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id         TEXT REFERENCES turns(id) ON DELETE SET NULL,
  role            TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  kind            TEXT NOT NULL DEFAULT 'normal'
                  CHECK(kind IN ('normal','context','compact_boundary','summary')),
  content         TEXT NOT NULL,
  tool_calls_json TEXT,
  tool_call_id    TEXT,
  interrupted     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  meta_json       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(turn_id);

-- ============ Provider / Model ============

CREATE TABLE IF NOT EXISTS provider_configs (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  api_key_plain TEXT,
  base_url      TEXT,
  enabled       INTEGER NOT NULL DEFAULT 0,
  config_json   TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_catalog (
  id                TEXT PRIMARY KEY,
  llm_provider      TEXT NOT NULL
                    CHECK(llm_provider IN ('openai','anthropic','gemini','openai-compat')),
  display_name      TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  context_window    INTEGER NOT NULL,
  pricing_json      TEXT,
  is_static         INTEGER NOT NULL DEFAULT 0,
  enabled           INTEGER NOT NULL DEFAULT 1,
  fetched_at        INTEGER
);

CREATE TABLE IF NOT EXISTS model_bindings (
  module   TEXT PRIMARY KEY
           CHECK(module IN ('chat','narrative','agent','compaction','emotion','tts','stt','vision','imagegen','router','plan-parse')),
  model_id TEXT NOT NULL REFERENCES model_catalog(id),
  voice_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}'
);

-- ============ Memory ============

CREATE TABLE IF NOT EXISTS memory_items (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK(kind IN ('user','feedback','project','reference')),
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  embedding         BLOB,
  source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  source_turn_id    TEXT REFERENCES turns(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  expires_at        INTEGER,
  importance        INTEGER NOT NULL DEFAULT 50,
  meta_json         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_items(kind);
CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_items(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory_items(importance DESC);

-- ============ Attachments ============

CREATE TABLE IF NOT EXISTS attachments (
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

CREATE TABLE IF NOT EXISTS attachment_chunks (
  id            TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  text          TEXT NOT NULL,
  embedding     BLOB,
  meta_json     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_chunks_attachment ON attachment_chunks(attachment_id, chunk_index);

-- ============ Artifact ============

CREATE TABLE IF NOT EXISTS artifacts (
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
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_turn ON artifacts(turn_id);

-- ============ Permission ============

CREATE TABLE IF NOT EXISTS permission_grants (
  id           TEXT PRIMARY KEY,
  tool_pattern TEXT NOT NULL,
  arg_matcher  TEXT,
  effect       TEXT NOT NULL CHECK(effect IN ('allow','ask','forbidden')),
  scope        TEXT NOT NULL CHECK(scope IN ('session','persistent')),
  session_id   TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK(source IN ('user','project','default')),
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grants_tool ON permission_grants(tool_pattern);

-- ============ Character Card ============

CREATE TABLE IF NOT EXISTS live2d_models (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  format       TEXT NOT NULL CHECK(format IN ('live2d','vrm')),
  storage_path TEXT NOT NULL,
  params_json  TEXT NOT NULL DEFAULT '{}',
  is_builtin   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS character_cards (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  version               TEXT NOT NULL DEFAULT 'v1.0.0',
  description           TEXT,
  system_prompt         TEXT NOT NULL,
  speech_patterns_json  TEXT NOT NULL DEFAULT '[]',
  forbidden_topics_json TEXT NOT NULL DEFAULT '[]',
  emotion_vocab_json    TEXT NOT NULL DEFAULT '[]',
  motion_vocab_json     TEXT NOT NULL DEFAULT '[]',
  live2d_model_id       TEXT REFERENCES live2d_models(id) ON DELETE SET NULL,
  is_active             INTEGER NOT NULL DEFAULT 0,
  is_builtin            INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_character_cards_active
  ON character_cards(is_active) WHERE is_active = 1;

-- ============ Provider Health ============

CREATE TABLE IF NOT EXISTS provider_health (
  llm_provider      TEXT PRIMARY KEY
                    CHECK(llm_provider IN ('openai','anthropic','gemini','openai-compat')),
  status            TEXT NOT NULL CHECK(status IN ('ok','failed','probing','unknown')),
  last_probed_at    INTEGER,
  latency_ms        INTEGER,
  last_error        TEXT,
  consecutive_fails INTEGER NOT NULL DEFAULT 0
);

-- ============ Settings ============

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ============ Telemetry ============

CREATE TABLE IF NOT EXISTS telemetry_events (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  turn_id     TEXT,
  kind        TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry_events(kind, created_at);

CREATE TABLE IF NOT EXISTS turn_usage (
  turn_id      TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  llm_provider TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd     REAL NOT NULL,
  duration_ms  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

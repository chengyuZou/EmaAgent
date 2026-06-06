-- ── Profile DB schema ─────────────────────────────────────────────────────────
--
-- profile.db lives in `~/.ema-agent/profile.db`.
-- Holds everything that is global and survives dataDir switches:
--
--   provider_configs / bindings / character_cards / live2d_models / settings
--   mcp_servers / skills
--   memory L0 (entity graph) + L2 (episodic items)
--
-- Memory L0 and L2 are global memories — they describe the user's identity,
-- relationships, and long-term facts and must not be lost when the active
-- dataDir changes. Only L1 (session_notes) lives in data.db because it is
-- a per-session rolling summary.
--
-- Development note: this is a single consolidated migration. New schema
-- changes during development are made here directly; versioned incremental
-- migrations are added only once the schema is stable for a shipped build.

-- ============ Provider configs ============

CREATE TABLE provider_configs (
  id                TEXT PRIMARY KEY,
  definition_id     TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  api_key_plain     TEXT,
  base_url          TEXT,
  enabled           INTEGER NOT NULL DEFAULT 0,
  config_json       TEXT NOT NULL DEFAULT '{}',
  capabilities_json TEXT NOT NULL DEFAULT '["llm"]',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE provider_health (
  provider_config_id TEXT PRIMARY KEY REFERENCES provider_configs(id) ON DELETE CASCADE,
  status             TEXT NOT NULL CHECK(status IN ('ok','failed','probing','unknown')),
  last_probed_at     INTEGER,
  latency_ms         INTEGER,
  last_error         TEXT,
  consecutive_fails  INTEGER NOT NULL DEFAULT 0
);

-- ============ Model bindings ============

CREATE TABLE model_bindings (
  module             TEXT    NOT NULL
                     CHECK(module IN (
                       -- LLM
                       'chat', 'narrative', 'agent',
                       'compaction', 'emotion', 'memory',
                       'router', 'plan-parse', 'title',
                       -- Python bridge
                       'embed', 'rerank', 'lightrag-llm',
                       -- TTS (single binding for all modes)
                       'tts',
                       -- Other clients
                       'stt', 'vision', 'imagegen'
                     )),
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE RESTRICT,
  model              TEXT    NOT NULL,
  voice_id           TEXT,
  config_json        TEXT    NOT NULL DEFAULT '{}',
  PRIMARY KEY (module, provider_config_id, model)
);

-- ============ Character cards + Live2D models ============

CREATE TABLE live2d_models (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  format       TEXT NOT NULL CHECK(format IN ('live2d','vrm')),
  storage_path TEXT NOT NULL,
  params_json  TEXT NOT NULL DEFAULT '{}',
  is_builtin   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE character_cards (
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
  voice_profile_json    TEXT NOT NULL DEFAULT '{}',
  is_active             INTEGER NOT NULL DEFAULT 0,
  is_builtin            INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_character_cards_active
  ON character_cards(is_active) WHERE is_active = 1;

-- ============ App settings ============

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ============ MCP server configurations ============

CREATE TABLE mcp_servers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  source_url   TEXT,
  config_json  TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  installed_at INTEGER NOT NULL
);

-- ============ Skills ============

CREATE TABLE skills (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  version        TEXT NOT NULL DEFAULT '1.0.0',
  description    TEXT NOT NULL DEFAULT '',
  source_url     TEXT,
  content_md     TEXT NOT NULL,
  activates_json TEXT NOT NULL DEFAULT '["agent"]',
  enabled        INTEGER NOT NULL DEFAULT 1,
  installed_at   INTEGER NOT NULL
);

-- ============ Memory Layer 0: entity graph (global) ============
--
-- Entities, relationships, and user facts that persist across all dataDirs.
-- source_session_id / source_turn_id are informational only — plain TEXT,
-- no FK because the referenced rows live in whichever data.db was active
-- at extraction time.

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
  source_session_id  TEXT,   -- informational; no FK (data.db cross-reference)
  source_turn_id     TEXT,   -- informational; no FK
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_lazy_updates_node ON memory_node_lazy_updates(node_id, created_at);

-- ============ Memory Layer 2: episodic items (global) ============
--
-- Extracted facts, preferences, projects, and references that apply across
-- all sessions and dataDirs. source_* fields are informational (no FK).

CREATE TABLE memory_items (
  id                     TEXT PRIMARY KEY,
  kind                   TEXT NOT NULL CHECK(kind IN ('user','feedback','project','reference')),
  title                  TEXT NOT NULL,
  body                   TEXT NOT NULL,
  embedding              BLOB,
  source_session_id      TEXT,   -- informational; no FK
  source_turn_id         TEXT,   -- informational; no FK
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  expires_at             INTEGER,
  importance             INTEGER NOT NULL DEFAULT 50,
  meta_json              TEXT NOT NULL DEFAULT '{}',
  modes_json             TEXT NOT NULL DEFAULT '["chat","agent","narrative"]',
  last_referenced_at     INTEGER NOT NULL DEFAULT 0,
  embedding_provider_id  TEXT,
  embedding_model        TEXT,
  embedding_dim          INTEGER
);
CREATE INDEX idx_memory_items_kind       ON memory_items(kind);
CREATE INDEX idx_memory_items_updated    ON memory_items(updated_at DESC);
CREATE INDEX idx_memory_items_importance ON memory_items(importance DESC);
CREATE INDEX idx_memory_items_lastref    ON memory_items(last_referenced_at DESC);

-- ============ Model catalogs (per-capability tables in profile.db) ============
--
-- Each capability gets its own table so fields stay relevant (no NULL hell).
-- model_name is the primary key — model capabilities are model properties,
-- not provider properties. gpt-4o has 128K context regardless of whether you
-- connect via OpenAI, OpenRouter, or Azure.
--
-- is_builtin = 1 rows are seeded here. Users can INSERT their own rows with
-- is_builtin = 0 via the settings UI. Builtin rows are updated via UPSERT on
-- migration (safe for re-run).

-- LLM models: context window + capability flags
CREATE TABLE llm_model_catalog (
  model_name      TEXT PRIMARY KEY,
  context_window  INTEGER NOT NULL,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_tools  INTEGER NOT NULL DEFAULT 1,
  supports_think  INTEGER NOT NULL DEFAULT 0,
  is_builtin      INTEGER NOT NULL DEFAULT 1
);

-- Embedding models: vector dimension + optional max_tokens per call
CREATE TABLE embed_model_catalog (
  model_name  TEXT PRIMARY KEY,
  dim         INTEGER NOT NULL,
  max_tokens  INTEGER,
  is_builtin  INTEGER NOT NULL DEFAULT 1
);

-- Rerank models: max concurrent chunks (no dimension needed — rerankers only sort)
CREATE TABLE rerank_model_catalog (
  model_name  TEXT PRIMARY KEY,
  max_chunks  INTEGER,
  is_builtin  INTEGER NOT NULL DEFAULT 1
);

-- TTS models: default output format, sample rate, and whether the model accepts
-- speed control. openai-tts clone path (CosyVoice2) hardcodes skipSpeedGain=true
-- so supports_speed=0 for those models. DashScope CosyVoice/QwenTTS and
-- GPT-SoVITS accept speed parameters.
CREATE TABLE tts_model_catalog (
  model_name          TEXT PRIMARY KEY,
  default_format      TEXT NOT NULL DEFAULT 'mp3',
  default_sample_rate INTEGER NOT NULL DEFAULT 24000,
  supports_speed      INTEGER NOT NULL DEFAULT 1,
  is_builtin          INTEGER NOT NULL DEFAULT 1
);

-- STT models: supported languages as JSON array ('[]' = auto-detect / all),
-- whether verbose_json (segment timestamps) is supported, and max audio duration.
CREATE TABLE stt_model_catalog (
  model_name          TEXT PRIMARY KEY,
  languages           TEXT NOT NULL DEFAULT '[]',
  supports_timestamps INTEGER NOT NULL DEFAULT 1,
  max_duration_s      INTEGER,
  is_builtin          INTEGER NOT NULL DEFAULT 1
);

-- ── Seed data ─────────────────────────────────────────────────────────────────

-- LLM
INSERT OR REPLACE INTO llm_model_catalog (model_name, context_window, supports_vision, supports_tools, supports_think) VALUES
  ('gpt-4.1',              1047576, 1, 1, 0),
  ('gpt-4.1-mini',         1047576, 1, 1, 0),
  ('gpt-4o',                128000, 1, 1, 0),
  ('gpt-4o-mini',           128000, 1, 1, 0),
  ('o3',                    200000, 0, 1, 1),
  ('o4-mini',               200000, 1, 1, 1),
  ('claude-opus-4-5',       200000, 1, 1, 1),
  ('claude-sonnet-4-5',     200000, 1, 1, 1),
  ('claude-haiku-4-5',      200000, 1, 1, 0),
  ('gemini-2.5-pro',       1048576, 1, 1, 1),
  ('gemini-2.5-flash',     1048576, 1, 1, 1),
  ('gemini-2.0-flash',     1000000, 1, 1, 0),
  ('deepseek-v4-flash',      64000, 0, 1, 1),
  ('deepseek-v4-pro',        64000, 0, 1, 1);

-- Embed
INSERT OR REPLACE INTO embed_model_catalog (model_name, dim, max_tokens) VALUES
  ('text-embedding-3-large', 3072, 8192),
  ('text-embedding-3-small', 1536, 8192),
  ('text-embedding-ada-002', 1536, 8191);

-- Rerank
INSERT OR REPLACE INTO rerank_model_catalog (model_name, max_chunks) VALUES
  ('cohere-rerank-v3.5', 1000);

-- TTS
INSERT OR REPLACE INTO tts_model_catalog (model_name, default_format, default_sample_rate, supports_speed) VALUES
  ('tts-1',    'mp3', 24000, 1),
  ('tts-1-hd', 'mp3', 24000, 1);

-- STT
INSERT OR REPLACE INTO stt_model_catalog (model_name, languages, supports_timestamps, max_duration_s) VALUES
  ('whisper-1', '[]', 1, 1500);

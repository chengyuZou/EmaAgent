-- ── Profile DB initial schema ────────────────────────────────────────────────
--
-- profile.db lives in `~/.ema-agent/profile.db` and holds data that's shared
-- across all registered data dirs:
--
--   - API keys & provider configs (one set for the whole app)
--   - Model catalog + bindings (one model preference set)
--   - Character cards (built-in + user-uploaded)
--   - Live2D models (referenced by character cards)
--   - App-level settings (UI theme, event display, etc.)
--
-- Switching the active data dir does NOT touch this DB. Sessions / memory /
-- audio all live in {dataDir}/data.db instead.

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

-- ============ Model catalog + bindings ============

CREATE TABLE model_catalog (
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

CREATE TABLE model_bindings (
  module             TEXT    NOT NULL
                     CHECK(module IN (
                       -- TS-side LLM modules
                       'chat', 'narrative', 'agent',
                       'compaction', 'emotion', 'memory',
                       'router', 'plan-parse', 'title',
                       -- LightRAG internal config (Python bridge)
                       'embed', 'rerank', 'lightrag-llm',
                       -- TTS modules — split by user-facing mode so chat /
                       -- narrative / agent can each pick a different provider
                       -- (e.g. fast cheap chat, high-quality narrative,
                       -- local agent). Voice identity always comes from the
                       -- active character card's voice_profile_json refAudios,
                       -- not from these bindings.
                       'tts_chat', 'tts_narrative', 'tts_agent',
                       -- Other TS-side clients
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
  -- Voice profile: refAudioPath / promptText / promptLang for voice-clone TTS.
  -- Catalog providers (OpenAI / ElevenLabs) ignore this and read voice from
  -- model_bindings.voice_id instead.
  voice_profile_json    TEXT NOT NULL DEFAULT '{}',
  is_active             INTEGER NOT NULL DEFAULT 0,
  is_builtin            INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_character_cards_active
  ON character_cards(is_active) WHERE is_active = 1;

-- ============ Settings (app-level, cross-data-dir) ============

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

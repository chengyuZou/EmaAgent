-- ════════════════════════════════════════════════════════════════════════════
-- PROFILE stream — ~/.ema-agent/profile.db. Global, cross-workspace state that
-- follows the *user*: provider configs, model bindings, character cards, app
-- settings, skills index, global memory (entity graph + episodic items), and the
-- knowledge_bases registry (named KBs, each living in its own kb.db elsewhere).
--
-- Consolidated initial schema (replaces 001–004).
-- ════════════════════════════════════════════════════════════════════════════

-- ── Providers ──────────────────────────────────────────────────────────────────

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

CREATE TABLE provider_llm_models (
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model              TEXT    NOT NULL,
  context_window     INTEGER NOT NULL,
  context_source     TEXT    NOT NULL DEFAULT 'table' CHECK(context_source IN ('live','table','manual')),
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, model)
);

CREATE INDEX idx_provider_llm_models_model ON provider_llm_models(model);

CREATE TABLE provider_embed_models (
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model              TEXT    NOT NULL,
  dim                INTEGER NOT NULL,
  dim_source         TEXT    NOT NULL DEFAULT 'table' CHECK(dim_source IN ('live','table','manual')),
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, model)
);

CREATE INDEX idx_provider_embed_models_model ON provider_embed_models(model);

CREATE TABLE provider_rerank_models (
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model              TEXT    NOT NULL,
  max_chunks         INTEGER,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, model)
);

CREATE TABLE provider_tts_models (
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model              TEXT    NOT NULL,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, model)
);

CREATE TABLE provider_stt_models (
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model              TEXT    NOT NULL,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, model)
);

CREATE TABLE provider_vision_models (
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model              TEXT    NOT NULL,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, model)
);

-- ── Model bindings ─────────────────────────────────────────────────────────────

CREATE TABLE model_bindings (
  module             TEXT    NOT NULL
                     CHECK(module IN (
                       'chat', 'narrative', 'agent',
                       'compaction', 'emotion', 'memory',
                       'router', 'plan-parse', 'title',
                       'embed', 'rerank', 'lightrag-embed', 'lightrag-llm',
                       'tts',
                       'stt', 'vision', 'imagegen'
                     )),
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE RESTRICT,
  model              TEXT    NOT NULL,
  voice_id           TEXT,
  config_json        TEXT    NOT NULL DEFAULT '{}',
  PRIMARY KEY (module, provider_config_id, model)
);

-- ── Character cards + Live2D ───────────────────────────────────────────────────

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

CREATE UNIQUE INDEX idx_character_cards_active ON character_cards(is_active) WHERE is_active = 1;

-- ── Settings (generic key-value JSON) ──────────────────────────────────────────

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── MCP servers ────────────────────────────────────────────────────────────────

CREATE TABLE mcp_servers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  source_url   TEXT,
  config_json  TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  tools_cache  TEXT,
  cached_at    INTEGER NOT NULL DEFAULT 0,
  installed_at INTEGER NOT NULL
);

-- ── Market sources(MCP / Skill / 未来 integration 共用)──────────────────────
-- 一个"市场源"= 一个可浏览可装条目的来源(官方 registry / GitHub 仓库 / 用户自传 JSON 索引)。
-- 与 mcp_servers / skills 区分:那俩是"已装实例",这张表是"从哪浏览"。
-- kind 不加 CHECK —— 业务包(mcp='mcp'/skill='skill'/未来 integration='integration')自由填,
-- 底层 marketplace 包不约束语义,保证未来加新 kind 零迁移。
-- config 结构由各业务包的 adapter 定义(github: owner/repo/ref; mcp-registry: baseUrl/mirrorUrl; ...)。

CREATE TABLE market_sources (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  type        TEXT NOT NULL,
  label       TEXT NOT NULL,
  config      TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  builtin     INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_market_sources_kind ON market_sources(kind);

-- ── Skills index (SKILL.md files live on disk; this is the cache) ──────────────

CREATE TABLE skills (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  version       TEXT NOT NULL DEFAULT '1.0.0',
  description   TEXT NOT NULL DEFAULT '',
  arg_hint      TEXT,
  dir_path      TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'user',
  source_url    TEXT,
  sha256        TEXT,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  content_mtime INTEGER NOT NULL DEFAULT 0,
  installed_at  INTEGER NOT NULL
);

-- ── Global memory (L0 entity graph + L2 episodic items) ────────────────────────

CREATE TABLE memory_nodes (
  id                    TEXT PRIMARY KEY,
  label                 TEXT NOT NULL,
  node_type             TEXT NOT NULL CHECK(node_type IN (
                          'user_fact', 'entity', 'event',
                          'emotion', 'preference', 'relationship'
                        )),
  description           TEXT NOT NULL,
  embedding             BLOB,
  embedding_provider_id TEXT,
  embedding_model       TEXT,
  embedding_dim         INTEGER,
  importance            INTEGER NOT NULL DEFAULT 50 CHECK(importance BETWEEN 0 AND 100),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  last_referenced_at    INTEGER NOT NULL,
  meta_json             TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX idx_memory_nodes_label_type ON memory_nodes(label, node_type);
CREATE INDEX idx_memory_nodes_type       ON memory_nodes(node_type);
CREATE INDEX idx_memory_nodes_lastref    ON memory_nodes(last_referenced_at DESC);
CREATE INDEX idx_memory_nodes_importance ON memory_nodes(importance DESC);

CREATE TABLE memory_edges (
  id                 TEXT PRIMARY KEY,
  from_node_id       TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  to_node_id         TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  relation           TEXT NOT NULL,
  mention_count      INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  last_referenced_at INTEGER NOT NULL,
  UNIQUE(from_node_id, to_node_id, relation)
);

CREATE INDEX idx_memory_edges_from ON memory_edges(from_node_id);
CREATE INDEX idx_memory_edges_to   ON memory_edges(to_node_id);

CREATE TABLE memory_node_lazy_updates (
  id                TEXT PRIMARY KEY,
  node_id           TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  fragment          TEXT NOT NULL,
  source_session_id TEXT,
  source_turn_id    TEXT,
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_lazy_updates_node ON memory_node_lazy_updates(node_id, created_at);

CREATE TABLE memory_items (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK(kind IN ('user','feedback','project','reference')),
  title                 TEXT NOT NULL,
  body                  TEXT NOT NULL,
  embedding             BLOB,
  embedding_provider_id TEXT,
  embedding_model       TEXT,
  embedding_dim         INTEGER,
  source_session_id     TEXT,
  source_turn_id        TEXT,
  importance            INTEGER NOT NULL DEFAULT 50,
  modes_json            TEXT NOT NULL DEFAULT '["chat","agent","narrative"]',
  meta_json             TEXT NOT NULL DEFAULT '{}',
  last_referenced_at    INTEGER NOT NULL DEFAULT 0,
  expires_at            INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX idx_memory_items_kind       ON memory_items(kind);
CREATE INDEX idx_memory_items_updated    ON memory_items(updated_at DESC);
CREATE INDEX idx_memory_items_importance ON memory_items(importance DESC);
CREATE INDEX idx_memory_items_lastref    ON memory_items(last_referenced_at DESC);

-- ── Knowledge-base registry (named KBs; each lives in its own kb.db at `path`) ──

CREATE TABLE knowledge_bases (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  path       TEXT    NOT NULL,          -- absolute folder: {path}/kb.db + {path}/files/
  is_active  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_kb_active ON knowledge_bases(is_active) WHERE is_active = 1;
CREATE UNIQUE INDEX idx_kb_name   ON knowledge_bases(name);

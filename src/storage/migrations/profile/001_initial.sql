-- profile.db 当前开发基线。
-- 由压缩前完整迁移链生成最终 Schema 后规范化导出。
-- 后续结构变更从 002_*.sql 开始追加。
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
  is_active             INTEGER NOT NULL DEFAULT 0,
  is_builtin            INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE character_live2d_variants (
  id                  TEXT PRIMARY KEY,
  character_card_id   TEXT NOT NULL REFERENCES character_cards(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  format              TEXT NOT NULL CHECK(format IN ('live2d','vrm')),
  entry_path          TEXT NOT NULL COLLATE NOCASE,
  runtime_config_path TEXT COLLATE NOCASE,
  position            INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
  is_primary          INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  resource_version    TEXT,
  content_sha256      TEXT,
  byte_size           INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  is_builtin          INTEGER NOT NULL DEFAULT 0 CHECK(is_builtin IN (0,1)),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(character_card_id, entry_path)
);

CREATE TABLE character_portraits (
  id                TEXT PRIMARY KEY,
  character_card_id TEXT NOT NULL REFERENCES character_cards(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  relative_path     TEXT NOT NULL COLLATE NOCASE,
  position          INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  mime_type         TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
  byte_size         INTEGER NOT NULL CHECK(byte_size >= 0),
  width             INTEGER NOT NULL CHECK(width > 0),
  height            INTEGER NOT NULL CHECK(height > 0),
  content_sha256    TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(character_card_id, relative_path)
);

CREATE TABLE character_voice_references (
  id                TEXT PRIMARY KEY,
  character_card_id TEXT NOT NULL REFERENCES character_cards(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  relative_path     TEXT NOT NULL COLLATE NOCASE,
  prompt_text       TEXT NOT NULL,
  prompt_lang       TEXT NOT NULL,
  position          INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  mime_type         TEXT NOT NULL,
  byte_size         INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  duration_ms       INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  content_sha256    TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(character_card_id, relative_path)
);

CREATE TABLE knowledge_bases (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  path       TEXT    NOT NULL,          -- 绝对文件夹:{path}/kb.db + {path}/files/
  is_active  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

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

CREATE TABLE mcp_servers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  source_url   TEXT,
  config_json  TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  tools_cache  TEXT,
  cached_at    INTEGER NOT NULL DEFAULT 0,
  installed_at INTEGER NOT NULL
, install_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (install_source IN ('manual', 'import', 'market')), market_source_id TEXT, market_source_type TEXT, package_registry TEXT, package_name TEXT, package_version TEXT, package_integrity TEXT);

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

CREATE TABLE memory_extraction_runs (
  run_id               TEXT PRIMARY KEY CHECK(length(run_id) > 0),
  session_id           TEXT NOT NULL CHECK(length(session_id) > 0),
  source_turn_id       TEXT NOT NULL CHECK(length(source_turn_id) > 0),
  note_delta           TEXT NOT NULL,
  nodes_count          INTEGER NOT NULL CHECK(nodes_count >= 0),
  edges_count          INTEGER NOT NULL CHECK(edges_count >= 0),
  items_count          INTEGER NOT NULL CHECK(items_count >= 0),
  lazy_updates_count   INTEGER NOT NULL CHECK(lazy_updates_count >= 0),
  committed_at         INTEGER NOT NULL
);

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
  profiles_json            TEXT NOT NULL DEFAULT '["chat","work"]',
  meta_json             TEXT NOT NULL DEFAULT '{}',
  last_referenced_at    INTEGER NOT NULL DEFAULT 0,
  expires_at            INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
, embedding_normalization TEXT, embedding_revision TEXT, embedding_space_id TEXT, embedding_evicted_at INTEGER, last_decayed_at INTEGER);

CREATE TABLE memory_node_lazy_updates (
  id                TEXT PRIMARY KEY,
  node_id           TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  fragment          TEXT NOT NULL,
  source_session_id TEXT,
  source_turn_id    TEXT,
  created_at        INTEGER NOT NULL
);

CREATE TABLE memory_node_sources (
  node_id           TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL,
  source_turn_id    TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (node_id, source_session_id, source_turn_id)
);

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
, embedding_normalization TEXT, embedding_revision TEXT, embedding_space_id TEXT, embedding_evicted_at INTEGER, last_decayed_at INTEGER);

CREATE TABLE "model_bindings" (
  module             TEXT    NOT NULL
                     CHECK(module IN (
                       'memory', 'title',
                       'lightrag-embed', 'lightrag-llm',
                       'tts',
                       'stt', 'vision', 'imagegen'
                     )),
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE RESTRICT,
  model              TEXT    NOT NULL,
  embedding_dimension INTEGER CHECK(embedding_dimension IS NULL OR embedding_dimension > 0),
  PRIMARY KEY (module, provider_config_id, model)
);

CREATE TABLE permission_rules (
  id             TEXT PRIMARY KEY,
  action         TEXT NOT NULL
                 CHECK(action IN ('allow', 'deny', 'ask')),
  tool_id        TEXT NOT NULL,
  path_glob      TEXT,
  scope          TEXT NOT NULL
                 CHECK(scope IN ('global', 'workspace')),
  workspace_root TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1
                 CHECK(enabled IN (0, 1)),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,

  CHECK(
    (scope = 'global' AND workspace_root IS NULL)
    OR
    (scope = 'workspace' AND workspace_root IS NOT NULL)
  )
);

CREATE TABLE provider_capability_configs (
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  capability         TEXT    NOT NULL CHECK(capability IN ('llm','embed','rerank','vision','tts','stt')),
  protocol           TEXT,
  base_url            TEXT,
  embedding_revision  TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, capability),
  CHECK(embedding_revision IS NULL OR capability = 'embed')
);

CREATE TABLE provider_configs (
  id                TEXT PRIMARY KEY,
  definition_id     TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  credential_envelope     TEXT,
  enabled           INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE provider_embed_models (
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model              TEXT    NOT NULL,
  dim                INTEGER NOT NULL,
  dim_source         TEXT    NOT NULL DEFAULT 'table' CHECK(dim_source IN ('live','table','manual')),
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, model)
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

CREATE TABLE provider_rerank_models (
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model              TEXT    NOT NULL,
  max_chunks         INTEGER,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, model)
);

CREATE TABLE provider_stt_models (
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model              TEXT    NOT NULL,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, model)
);

CREATE TABLE provider_tts_models (
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

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

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

CREATE UNIQUE INDEX idx_character_cards_active
  ON character_cards(is_active)
  WHERE is_active = 1;

CREATE INDEX idx_character_live2d_order
  ON character_live2d_variants(character_card_id, position ASC, id ASC);

CREATE UNIQUE INDEX idx_character_live2d_primary
  ON character_live2d_variants(character_card_id)
  WHERE is_primary = 1;

CREATE INDEX idx_character_portraits_order
  ON character_portraits(character_card_id, position ASC, id ASC);

CREATE UNIQUE INDEX idx_character_portraits_primary
  ON character_portraits(character_card_id)
  WHERE is_primary = 1;

CREATE INDEX idx_character_voice_order
  ON character_voice_references(character_card_id, position ASC, id ASC);

CREATE UNIQUE INDEX idx_character_voice_primary
  ON character_voice_references(character_card_id)
  WHERE is_primary = 1;

CREATE UNIQUE INDEX idx_kb_active ON knowledge_bases(is_active) WHERE is_active = 1;

CREATE UNIQUE INDEX idx_kb_name   ON knowledge_bases(name);

CREATE INDEX idx_lazy_updates_node
  ON memory_node_lazy_updates(node_id, created_at ASC, id ASC);

CREATE INDEX idx_market_sources_kind ON market_sources(kind);

CREATE INDEX idx_memory_edges_from ON memory_edges(from_node_id);

CREATE INDEX idx_memory_edges_to   ON memory_edges(to_node_id);

CREATE INDEX idx_memory_items_decay
  ON memory_items(last_referenced_at ASC, last_decayed_at ASC, id ASC)
  WHERE importance > 0;

CREATE INDEX idx_memory_items_embedding_space
  ON memory_items(embedding_space_id, updated_at, id)
  WHERE embedding IS NOT NULL;

CREATE INDEX idx_memory_items_importance ON memory_items(importance DESC);

CREATE INDEX idx_memory_items_kind       ON memory_items(kind);

CREATE INDEX idx_memory_items_lastref    ON memory_items(last_referenced_at DESC);

CREATE INDEX idx_memory_items_updated    ON memory_items(updated_at DESC);

CREATE INDEX idx_memory_node_sources_node ON memory_node_sources(node_id, created_at);

CREATE INDEX idx_memory_nodes_decay
  ON memory_nodes(last_referenced_at ASC, last_decayed_at ASC, id ASC)
  WHERE importance > 0;

CREATE INDEX idx_memory_nodes_embedding_space
  ON memory_nodes(embedding_space_id, updated_at, id)
  WHERE embedding IS NOT NULL;

CREATE INDEX idx_memory_nodes_importance ON memory_nodes(importance DESC);

CREATE UNIQUE INDEX idx_memory_nodes_label_type ON memory_nodes(label, node_type);

CREATE INDEX idx_memory_nodes_lastref    ON memory_nodes(last_referenced_at DESC);

CREATE INDEX idx_memory_nodes_type       ON memory_nodes(node_type);

CREATE INDEX idx_permission_rules_enabled
ON permission_rules(enabled, scope, tool_id);

CREATE UNIQUE INDEX idx_permission_rules_selector
ON permission_rules(
  scope,
  IFNULL(workspace_root, ''),
  tool_id,
  IFNULL(path_glob, '')
);

CREATE INDEX idx_provider_capability_enabled
  ON provider_capability_configs(capability, enabled, provider_config_id);

CREATE INDEX idx_provider_embed_models_model ON provider_embed_models(model);

CREATE INDEX idx_provider_llm_models_model ON provider_llm_models(model);

-- profile.db 当前开发基线。
-- 由压缩前完整迁移链生成最终 Schema 后规范化导出。
-- 后续结构变更从 002_*.sql 开始追加。
CREATE TABLE character_cards (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  system_prompt         TEXT NOT NULL,
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
  name                TEXT NOT NULL,
  stage_scale         REAL NOT NULL DEFAULT 1 CHECK(stage_scale BETWEEN 0.1 AND 5),
  stage_offset_x      REAL NOT NULL DEFAULT 0 CHECK(stage_offset_x BETWEEN -1 AND 1),
  stage_offset_y      REAL NOT NULL DEFAULT 0 CHECK(stage_offset_y BETWEEN -1 AND 1),
  is_primary          INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  byte_size           INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE character_illustrations (
  id                TEXT PRIMARY KEY,
  character_card_id TEXT NOT NULL REFERENCES character_cards(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  stage_scale       REAL NOT NULL DEFAULT 1 CHECK(stage_scale BETWEEN 0.1 AND 5),
  stage_offset_x    REAL NOT NULL DEFAULT 0 CHECK(stage_offset_x BETWEEN -1 AND 1),
  stage_offset_y    REAL NOT NULL DEFAULT 0 CHECK(stage_offset_y BETWEEN -1 AND 1),
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  byte_size         INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE character_voice_references (
  id                TEXT PRIMARY KEY,
  character_card_id TEXT NOT NULL REFERENCES character_cards(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  prompt_text       TEXT NOT NULL,
  prompt_lang       TEXT NOT NULL,
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  mime_type         TEXT NOT NULL,
  byte_size         INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  duration_ms       INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE knowledge_bases (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  path       TEXT    NOT NULL,          -- 绝对文件夹:{path}/kb.db + {path}/files/
  is_active  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE mcp_servers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  source_url   TEXT,
  config_json  TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  tools_cache  TEXT,
  cached_at    INTEGER NOT NULL DEFAULT 0,
  installed_at INTEGER NOT NULL,
  -- 安装溯源:registry 形态的 registry_source_id 允许悬空(源删除后保留记录,
  -- UI 显示"来源已删除"),故不加外键;启动规格锁定在 config_json 本体。
  install_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (install_source IN ('manual', 'import', 'registry')),
  registry_source_id TEXT,
  registry_entry_id  TEXT,
  registry_version   TEXT
);

-- MCP Registry 目录源:官方 Registry 是 builtin=1 的种子记录,用户可加同协议镜像。
-- 浏览与更新检查都是即时拉取,目录不落库,故无 fetch 状态/etag 列。
CREATE TABLE mcp_registry_sources (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  registry_url TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  builtin      INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

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
  -- 当前使用的协议；NULL = 该能力停用（已配协议保留在 protocols 表）
  active_protocol    TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, capability)
);

-- 同一能力允许配置多档协议（如 DeepSeek LLM 的 openai/anthropic 双协议），
-- 切换激活协议不丢另一档的自定义地址。
CREATE TABLE provider_capability_protocols (
  provider_config_id TEXT NOT NULL,
  capability         TEXT NOT NULL,
  protocol           TEXT NOT NULL,
  base_url           TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, capability, protocol),
  FOREIGN KEY (provider_config_id, capability)
    REFERENCES provider_capability_configs(provider_config_id, capability) ON DELETE CASCADE
);

CREATE TABLE provider_configs (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT,
  display_name      TEXT NOT NULL,
  credential_envelope     TEXT,
  enabled           INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE provider_health (
  provider_config_id TEXT PRIMARY KEY REFERENCES provider_configs(id) ON DELETE CASCADE,
  status             TEXT NOT NULL CHECK(status IN ('ok','failed','unknown')),
  last_probed_at     INTEGER,
  latency_ms         INTEGER,
  last_error         TEXT
);

CREATE TABLE provider_models (
  provider_config_id TEXT    NOT NULL,
  capability         TEXT    NOT NULL CHECK(capability IN ('llm','embed','rerank','vision','tts','stt')),
  model              TEXT    NOT NULL,
  context_window     INTEGER,
  max_output         INTEGER,
  tool_call          INTEGER CHECK(tool_call IS NULL OR tool_call IN (0,1)),
  reasoning          INTEGER CHECK(reasoning IS NULL OR reasoning IN (0,1)),
  temperature        INTEGER CHECK(temperature IS NULL OR temperature IN (0,1)),
  input_image        INTEGER CHECK(input_image IS NULL OR input_image IN (0,1)),
  embedding_dim      INTEGER,
  rerank_max_chunks  INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, capability, model),
  FOREIGN KEY (provider_config_id, capability)
    REFERENCES provider_capability_configs(provider_config_id, capability)
    ON DELETE CASCADE,
  CHECK(
    (capability = 'llm' AND context_window > 0 AND embedding_dim IS NULL AND rerank_max_chunks IS NULL)
    OR
    (capability = 'embed' AND embedding_dim > 0 AND context_window IS NULL
      AND max_output IS NULL AND tool_call IS NULL AND reasoning IS NULL
      AND temperature IS NULL AND input_image IS NULL AND rerank_max_chunks IS NULL)
    OR
    (capability = 'rerank' AND context_window IS NULL AND max_output IS NULL
      AND tool_call IS NULL AND reasoning IS NULL AND temperature IS NULL
      AND input_image IS NULL AND embedding_dim IS NULL)
    OR
    (capability IN ('vision','tts','stt') AND context_window IS NULL AND max_output IS NULL
      AND tool_call IS NULL AND reasoning IS NULL AND temperature IS NULL
      AND input_image IS NULL AND embedding_dim IS NULL AND rerank_max_chunks IS NULL)
  ),
  CHECK(max_output IS NULL OR max_output > 0),
  CHECK(rerank_max_chunks IS NULL OR rerank_max_chunks > 0)
);

CREATE TABLE model_bindings (
  module             TEXT PRIMARY KEY CHECK(module IN (
                       'memory', 'title',
                       'lightrag-embed', 'lightrag-llm',
                       'tts', 'stt', 'vision'
                     )),
  capability         TEXT NOT NULL CHECK(capability IN ('llm','embed','rerank','vision','tts','stt')),
  provider_config_id TEXT NOT NULL,
  model              TEXT NOT NULL,
  CHECK(
    (module IN ('memory','title','lightrag-llm') AND capability = 'llm')
    OR (module = 'lightrag-embed' AND capability = 'embed')
    OR (module = 'tts' AND capability = 'tts')
    OR (module = 'stt' AND capability = 'stt')
    OR (module = 'vision' AND capability = 'vision')
  ),
  FOREIGN KEY (provider_config_id, capability, model)
    REFERENCES provider_models(provider_config_id, capability, model)
    ON DELETE CASCADE
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- skills: 目录是事实源,本表只是索引/溯源/对账。
-- 无 enabled 列:启用状态统一由 Settings skill.disabledKeys 决定(deny-list)。
-- id 稳定:手动放置 = 归一化路径哈希;站点安装 = site_<siteId>_<entryId>。
CREATE TABLE skills (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL DEFAULT '1.0.0',
  description   TEXT NOT NULL DEFAULT '',
  arg_hint      TEXT,
  dir_path      TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'user',
  source_url    TEXT,
  sha256        TEXT,
  site_id       TEXT,
  site_entry_id TEXT,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  content_mtime INTEGER NOT NULL DEFAULT 0,
  installed_at  INTEGER NOT NULL
);

-- skill_sites: 市场面站点实体 + 索引缓存。站点的 enabled 是实体状态,与技能启用无关。
CREATE TABLE skill_sites (
  id             TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  index_url      TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  builtin        INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  auto_update    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  index_json     TEXT,
  schema_version INTEGER,
  last_fetch_at  INTEGER,
  fetch_status   TEXT NOT NULL DEFAULT 'never',
  last_error     TEXT,
  etag           TEXT,
  last_modified  TEXT,
  updated_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_character_cards_active
  ON character_cards(is_active)
  WHERE is_active = 1;

CREATE INDEX idx_character_live2d_order
  ON character_live2d_variants(character_card_id, created_at ASC, id ASC);

CREATE UNIQUE INDEX idx_character_live2d_primary
  ON character_live2d_variants(character_card_id)
  WHERE is_primary = 1;

CREATE INDEX idx_character_illustrations_order
  ON character_illustrations(character_card_id, created_at ASC, id ASC);

CREATE UNIQUE INDEX idx_character_illustrations_primary
  ON character_illustrations(character_card_id)
  WHERE is_primary = 1;

CREATE INDEX idx_character_voice_order
  ON character_voice_references(character_card_id, created_at ASC, id ASC);

CREATE UNIQUE INDEX idx_character_voice_primary
  ON character_voice_references(character_card_id)
  WHERE is_primary = 1;

CREATE UNIQUE INDEX idx_kb_active ON knowledge_bases(is_active) WHERE is_active = 1;

CREATE UNIQUE INDEX idx_kb_name   ON knowledge_bases(name);

CREATE INDEX idx_lazy_updates_node
  ON memory_node_lazy_updates(node_id, created_at ASC, id ASC);

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

CREATE INDEX idx_provider_capability_active
  ON provider_capability_configs(capability, provider_config_id)
  WHERE active_protocol IS NOT NULL;

CREATE INDEX idx_provider_models_capability_model
  ON provider_models(capability, model, provider_config_id);

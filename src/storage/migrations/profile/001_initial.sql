-- profile.db 当前开发基线。
-- 由压缩前完整迁移链生成最终 Schema 后规范化导出。
-- 后续结构变更从 002_*.sql 开始追加。
CREATE TABLE characters (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  directory_name        TEXT NOT NULL,
  persona_prompt        TEXT NOT NULL,
  is_active             INTEGER NOT NULL DEFAULT 0,
  is_builtin            INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE(directory_name)
);

CREATE TABLE character_live2d_models (
  id                  TEXT PRIMARY KEY,
  character_id        TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  directory_name      TEXT NOT NULL,
  emotion_vocab_json  TEXT NOT NULL DEFAULT '[]',
  motion_vocab_json   TEXT NOT NULL DEFAULT '[]',
  stage_scale         REAL NOT NULL DEFAULT 1 CHECK(stage_scale BETWEEN 0.1 AND 5),
  stage_offset_x      REAL NOT NULL DEFAULT 0 CHECK(stage_offset_x BETWEEN -1 AND 1),
  stage_offset_y      REAL NOT NULL DEFAULT 0 CHECK(stage_offset_y BETWEEN -1 AND 1),
  is_primary          INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  byte_size           INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(character_id, directory_name)
);

CREATE TABLE character_illustrations (
  id                TEXT PRIMARY KEY,
  character_id      TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  file_name         TEXT NOT NULL,
  stage_scale       REAL NOT NULL DEFAULT 1 CHECK(stage_scale BETWEEN 0.1 AND 5),
  stage_offset_x    REAL NOT NULL DEFAULT 0 CHECK(stage_offset_x BETWEEN -1 AND 1),
  stage_offset_y    REAL NOT NULL DEFAULT 0 CHECK(stage_offset_y BETWEEN -1 AND 1),
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  byte_size         INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(character_id, file_name)
);

CREATE TABLE character_voice_samples (
  id                TEXT PRIMARY KEY,
  character_id      TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  file_name         TEXT NOT NULL,
  prompt_text       TEXT NOT NULL,
  prompt_lang       TEXT NOT NULL,
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  mime_type         TEXT NOT NULL,
  byte_size         INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  duration_ms       INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(character_id, file_name)
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

CREATE TABLE providers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  -- UI 图标注册表 key；NULL = 不显示图标（自建 provider 可以没有品牌图标）
  icon_id    TEXT,
  auth_type  TEXT NOT NULL CHECK(auth_type IN ('none','bearer')),
  -- 一个 Provider 一把 key（V1 明文入库）；NULL = 未配置
  key_value  TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE provider_capabilities (
  provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  capability      TEXT NOT NULL CHECK(capability IN ('llm','embed','rerank','vision','tts','stt')),
  -- 当前使用的协议；NULL = 该能力停用（已配协议保留在 protocols 表）
  active_protocol TEXT,
  -- 该能力的 models.dev 源 id（加模型时的参数预填来源）
  models_dev_id   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (provider_id, capability)
);

-- 同一能力允许配置多档协议（如 DeepSeek LLM 的 openai/anthropic 双协议），
-- 切换激活协议不丢另一档的自定义地址。
CREATE TABLE provider_protocols (
  provider_id TEXT NOT NULL,
  capability  TEXT NOT NULL,
  protocol    TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (provider_id, capability, protocol),
  FOREIGN KEY (provider_id, capability)
    REFERENCES provider_capabilities(provider_id, capability) ON DELETE CASCADE
);

CREATE TABLE provider_health (
  provider_id    TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  capability     TEXT NOT NULL CHECK(capability IN ('llm','embed','rerank','vision','tts','stt')),
  status         TEXT NOT NULL CHECK(status IN ('ok','failed','unknown')),
  last_probed_at INTEGER,
  latency_ms     INTEGER,
  last_error     TEXT,
  PRIMARY KEY (provider_id, capability)
);

CREATE TABLE provider_models (
  provider_id        TEXT    NOT NULL,
  capability         TEXT    NOT NULL CHECK(capability IN ('llm','embed','rerank','vision','tts','stt')),
  model_id           TEXT    NOT NULL,
  -- 显示名快照（目录落行时自带）；NULL = 前端回退显示 model_id
  name               TEXT,
  -- 'user' = 手写（可编辑/启停/删除）；'dev' = models.dev 同步（禁修改，可启停/删除）
  source             TEXT    NOT NULL DEFAULT 'user' CHECK(source IN ('user','dev')),
  -- 启停开关：1 = 启用（绑定/available/探活准入）；新增 dev 行默认 0
  enabled            INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
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
  PRIMARY KEY (provider_id, capability, model_id),
  FOREIGN KEY (provider_id, capability)
    REFERENCES provider_capabilities(provider_id, capability)
    ON DELETE CASCADE,
  CHECK(
    (capability IN ('llm','vision') AND context_window > 0 AND embedding_dim IS NULL AND rerank_max_chunks IS NULL)
    OR
    (capability = 'embed' AND embedding_dim > 0 AND context_window IS NULL
      AND max_output IS NULL AND tool_call IS NULL AND reasoning IS NULL
      AND temperature IS NULL AND input_image IS NULL AND rerank_max_chunks IS NULL)
    OR
    (capability = 'rerank' AND context_window IS NULL AND max_output IS NULL
      AND tool_call IS NULL AND reasoning IS NULL AND temperature IS NULL
      AND input_image IS NULL AND embedding_dim IS NULL)
    OR
    (capability IN ('tts','stt') AND context_window IS NULL AND max_output IS NULL
      AND tool_call IS NULL AND reasoning IS NULL AND temperature IS NULL
      AND input_image IS NULL AND embedding_dim IS NULL AND rerank_max_chunks IS NULL)
  ),
  CHECK(max_output IS NULL OR max_output > 0),
  CHECK(rerank_max_chunks IS NULL OR rerank_max_chunks > 0)
);

-- 模型绑定:每个业务模块只绑定一个已启用模型；绑定与选中入口断言连接可解析。
-- module 枚举与 providers/modelBindings.ts 的 MODEL_BINDING_MODULES 保持一致;
-- 命名统一为 <域>-<能力>(memory-llm/kb-embed/...);memory 只消费 llm(双轨重构后),
-- kb 的 embed/rerank 原来在 settings JSON,已迁出到本表。
CREATE TABLE model_bindings (
  module      TEXT PRIMARY KEY CHECK(module IN (
                'memory-llm',
                'kb-embed', 'kb-rerank',
                'title',
                'lightrag-embed', 'lightrag-llm',
                'tts', 'stt', 'vision'
              )),
  capability  TEXT NOT NULL CHECK(capability IN ('llm','embed','rerank','vision','tts','stt')),
  provider_id TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  CHECK(
    (module IN ('memory-llm','title','lightrag-llm') AND capability = 'llm')
    OR (module IN ('kb-embed','lightrag-embed') AND capability = 'embed')
    OR (module = 'kb-rerank' AND capability = 'rerank')
    OR (module = 'tts' AND capability = 'tts')
    OR (module = 'stt' AND capability = 'stt')
    OR (module = 'vision' AND capability = 'vision')
  ),
  FOREIGN KEY (provider_id, capability, model_id)
    REFERENCES provider_models(provider_id, capability, model_id)
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

CREATE UNIQUE INDEX idx_characters_active
  ON characters(is_active)
  WHERE is_active = 1;

CREATE INDEX idx_character_live2d_models_order
  ON character_live2d_models(character_id, created_at ASC, id ASC);

CREATE UNIQUE INDEX idx_character_live2d_models_primary
  ON character_live2d_models(character_id)
  WHERE is_primary = 1;

CREATE INDEX idx_character_illustrations_order
  ON character_illustrations(character_id, created_at ASC, id ASC);

CREATE UNIQUE INDEX idx_character_illustrations_primary
  ON character_illustrations(character_id)
  WHERE is_primary = 1;

CREATE INDEX idx_character_voice_samples_order
  ON character_voice_samples(character_id, created_at ASC, id ASC);

CREATE UNIQUE INDEX idx_character_voice_samples_primary
  ON character_voice_samples(character_id)
  WHERE is_primary = 1;

CREATE UNIQUE INDEX idx_kb_active ON knowledge_bases(is_active) WHERE is_active = 1;

CREATE UNIQUE INDEX idx_kb_name   ON knowledge_bases(name);

CREATE INDEX idx_provider_capability_active
  ON provider_capabilities(capability, provider_id)
  WHERE active_protocol IS NOT NULL;

CREATE INDEX idx_provider_models_capability_model
  ON provider_models(capability, model_id, provider_id);

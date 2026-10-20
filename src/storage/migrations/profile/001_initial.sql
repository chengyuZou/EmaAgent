CREATE TABLE characters (
  name                  TEXT PRIMARY KEY,
  display_name          TEXT,
  description           TEXT,
  persona_prompt        TEXT NOT NULL,
  stage_kind            TEXT NOT NULL DEFAULT 'blank'
                          CHECK(stage_kind IN ('live2d','illustration','blank')),
  is_active             INTEGER NOT NULL DEFAULT 0,
  last_activated_at     INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE character_live2d_models (
  name                TEXT NOT NULL,
  character_name      TEXT NOT NULL REFERENCES characters(name) ON DELETE CASCADE,
  display_name        TEXT NOT NULL,
  stage_scale         REAL NOT NULL DEFAULT 1 CHECK(stage_scale BETWEEN 0.1 AND 5),
  stage_offset_x      REAL NOT NULL DEFAULT 0 CHECK(stage_offset_x BETWEEN -1 AND 1),
  stage_offset_y      REAL NOT NULL DEFAULT 0 CHECK(stage_offset_y BETWEEN -1 AND 1),
  is_primary          INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  byte_size           INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY(character_name, name)
);

CREATE TABLE character_illustrations (
  name              TEXT NOT NULL,
  character_name    TEXT NOT NULL REFERENCES characters(name) ON DELETE CASCADE,
  display_name      TEXT NOT NULL,
  expression        TEXT,
  stage_scale       REAL NOT NULL DEFAULT 1 CHECK(stage_scale BETWEEN 0.1 AND 5),
  stage_offset_x    REAL NOT NULL DEFAULT 0 CHECK(stage_offset_x BETWEEN -1 AND 1),
  stage_offset_y    REAL NOT NULL DEFAULT 0 CHECK(stage_offset_y BETWEEN -1 AND 1),
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  byte_size         INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY(character_name, name)
);

CREATE TABLE character_voice_samples (
  name              TEXT NOT NULL,
  character_name    TEXT NOT NULL REFERENCES characters(name) ON DELETE CASCADE,
  display_name      TEXT NOT NULL,
  prompt_text       TEXT NOT NULL,
  prompt_lang       TEXT NOT NULL,
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  mime_type         TEXT NOT NULL,
  byte_size         INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  duration_ms       INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY(character_name, name)
);

CREATE TABLE providers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  -- Brand icon key. NULL uses the generic provider icon.
  icon_id    TEXT,
  auth_type  TEXT NOT NULL CHECK(auth_type IN ('none','bearer')),
  -- One plaintext credential per provider. NULL means not configured.
  key_value  TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE provider_capabilities (
  provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  capability      TEXT NOT NULL CHECK(capability IN ('llm','embed','rerank','vision','tts','stt')),
  -- NULL disables the capability without removing its saved protocols.
  active_protocol TEXT,
  -- models.dev source used to prefill model parameters.
  models_dev_id   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (provider_id, capability)
);

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

CREATE TABLE provider_models (
  provider_id        TEXT    NOT NULL,
  capability         TEXT    NOT NULL CHECK(capability IN ('llm','embed','rerank','vision','tts','stt')),
  model_id           TEXT    NOT NULL,
  -- NULL falls back to model_id in the UI.
  name               TEXT,
  -- Catalog parameters are read-only; enabled can change for either source.
  source             TEXT    NOT NULL DEFAULT 'user' CHECK(source IN ('user','dev')),
  -- Only enabled models are available for selection, binding and probing.
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

CREATE TABLE provider_health (
  provider_id    TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  capability     TEXT NOT NULL CHECK(capability IN ('llm','embed','rerank','vision','tts','stt')),
  status         TEXT NOT NULL CHECK(status IN ('ok','failed','unknown')),
  last_probed_at INTEGER,
  latency_ms     INTEGER,
  last_error     TEXT,
  PRIMARY KEY (provider_id, capability)
);

CREATE TABLE model_bindings (
  module TEXT PRIMARY KEY CHECK (module IN (
    'memory-llm', 'narrative-embed', 'narrative-llm', 'narrative-rerank', 'tts', 'stt', 'vision'
  )),
  capability TEXT NOT NULL CHECK (capability IN ('llm', 'embed', 'rerank', 'vision', 'tts', 'stt')),
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  CHECK (
    (module IN ('memory-llm', 'narrative-llm') AND capability = 'llm')
    OR (module = 'narrative-embed' AND capability = 'embed')
    OR (module = 'narrative-rerank' AND capability = 'rerank')
    OR (module = 'tts' AND capability = 'tts')
    OR (module = 'stt' AND capability = 'stt')
    OR (module = 'vision' AND capability = 'vision')
  ),
  FOREIGN KEY (provider_id, capability, model_id)
    REFERENCES provider_models(provider_id, capability, model_id) ON DELETE CASCADE
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE skills (
  path          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       TEXT,
  description   TEXT NOT NULL DEFAULT '',
  dir_path      TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  installed_at  INTEGER NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('builtin', 'user')),
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE mcp_servers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  config_json  TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  tools_cache  TEXT,
  installed_at INTEGER NOT NULL,
  install_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (install_source IN ('manual', 'import', 'official')),
  market_entry_id TEXT
);

CREATE TABLE mcp_market_entries (
  source         TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  repository_url TEXT,
  detail_url     TEXT NOT NULL,
  PRIMARY KEY(source, external_id)
);

CREATE TABLE mcp_market_fetch_state (
  source      TEXT PRIMARY KEY,
  next_cursor TEXT
);

CREATE INDEX idx_character_illustrations_order
  ON character_illustrations(character_name, created_at ASC, name ASC);

CREATE UNIQUE INDEX idx_character_illustrations_primary
  ON character_illustrations(character_name)
  WHERE is_primary = 1;

CREATE INDEX idx_character_live2d_models_order
  ON character_live2d_models(character_name, created_at ASC, name ASC);

CREATE UNIQUE INDEX idx_character_live2d_models_primary
  ON character_live2d_models(character_name)
  WHERE is_primary = 1;

CREATE INDEX idx_character_voice_samples_order
  ON character_voice_samples(character_name, created_at ASC, name ASC);

CREATE UNIQUE INDEX idx_character_voice_samples_primary
  ON character_voice_samples(character_name)
  WHERE is_primary = 1;

CREATE UNIQUE INDEX idx_characters_active
  ON characters(is_active)
  WHERE is_active = 1;

CREATE INDEX idx_mcp_market_entries_page
  ON mcp_market_entries(source, name COLLATE NOCASE, external_id);

CREATE INDEX idx_provider_capability_active
  ON provider_capabilities(capability, provider_id)
  WHERE active_protocol IS NOT NULL;

CREATE INDEX idx_provider_models_capability_model
  ON provider_models(capability, model_id, provider_id);

-- Built-in provider addresses and protocols. Credentials and model selections are configured in Settings.
INSERT OR IGNORE INTO providers (id, name, icon_id, auth_type, created_at, updated_at) VALUES
  ('openai',      'OpenAI',               'openai',      'bearer',  1,  1),
  ('anthropic',   'Anthropic',            'anthropic',   'bearer',  2,  2),
  ('gemini',      'Google Gemini',        'gemini',      'bearer',  3,  3),
  ('deepseek',    'DeepSeek',             'deepseek',    'bearer',  4,  4),
  ('moonshotai-cn', 'Moonshot Kimi-CN',   'moonshot',    'bearer',  5,  5),
  ('zhipu',       '智谱 GLM',             'zhipu',       'bearer',  6,  6),
  ('openrouter',  'OpenRouter',           'openrouter',  'bearer',  7,  7),
  ('groq',        'Groq',                 'groq',        'bearer',  8,  8),
  ('mistral',     'Mistral',              'mistral',     'bearer',  9,  9),
  ('xai',         'xAI Grok',             'xai',         'bearer', 10, 10),
  ('perplexity',  'Perplexity',           'perplexity',  'bearer', 11, 11),
  ('together',    'Together AI',          'together',    'bearer', 12, 12),
  ('fireworks',   'Fireworks AI',         'fireworks',   'bearer', 13, 13),
  ('ollama',      'Ollama',               'ollama',      'none',   14, 14),
  ('lmstudio',    'LM Studio',            'lmstudio',    'none',   15, 15),
  ('siliconflow-cn', 'SiliconFlow-CN',    'siliconflow', 'bearer', 16, 16),
  ('jina',        'Jina AI',              'jina',        'bearer', 17, 17),
  ('dashscope',   '阿里云百炼 (DashScope)', 'dashscope', 'bearer',  18, 18),
  ('gpt-sovits',  'GPT-SoVITS (本地)',    'gpt-sovits',  'none',   19, 19);

INSERT OR IGNORE INTO provider_capabilities
  (provider_id, capability, active_protocol, models_dev_id, created_at, updated_at) VALUES
  ('openai',      'llm',    'openai-llm', 'openai',      1, 1),
  ('openai',      'embed',  'openai-embed', NULL,          1, 1),
  ('openai',      'vision', 'openai-llm', 'openai',      1, 1),
  ('openai',      'stt',    'openai-stt', NULL,          1, 1),
  ('anthropic',   'llm',    'anthropic-llm', 'anthropic',   2, 2),
  ('anthropic',   'vision', 'anthropic-llm', 'anthropic',   2, 2),
  ('gemini',      'llm',    'gemini-llm', 'google',      3, 3),
  ('gemini',      'vision', 'gemini-llm', 'google',      3, 3),
  ('deepseek',    'llm',    'openai-llm', 'deepseek',    4, 4),
  ('deepseek',    'vision', 'openai-llm', 'deepseek',    4, 4),
  ('moonshotai-cn', 'llm',  'openai-llm', 'moonshotai-cn', 5, 5),
  ('moonshotai-cn', 'vision', 'openai-llm', 'moonshotai-cn', 5, 5),
  ('zhipu',       'llm',    'openai-llm', 'zhipuai',     6, 6),
  ('zhipu',       'embed',  'openai-embed', NULL,          6, 6),
  ('zhipu',       'vision', 'openai-llm', 'zhipuai',     6, 6),
  ('openrouter',  'llm',    'openai-llm', 'openrouter',  7, 7),
  ('openrouter',  'vision', 'openai-llm', 'openrouter',  7, 7),
  ('groq',        'llm',    'openai-llm', 'groq',        8, 8),
  ('groq',        'vision', 'openai-llm', 'groq',        8, 8),
  ('mistral',     'llm',    'openai-llm', 'mistral',     9, 9),
  ('mistral',     'vision', 'openai-llm', 'mistral',     9, 9),
  ('xai',         'llm',    'openai-llm', 'xai',        10, 10),
  ('xai',         'vision', 'openai-llm', 'xai',        10, 10),
  ('perplexity',  'llm',    'openai-llm', 'perplexity', 11, 11),
  ('perplexity',  'vision', 'openai-llm', 'perplexity', 11, 11),
  ('together',    'llm',    'openai-llm', 'togetherai', 12, 12),
  ('together',    'embed',  'openai-embed', NULL,         12, 12),
  ('together',    'vision', 'openai-llm', 'togetherai', 12, 12),
  ('fireworks',   'llm',    'openai-llm', 'fireworks-ai', 13, 13),
  ('fireworks',   'vision', 'openai-llm', 'fireworks-ai', 13, 13),
  ('ollama',      'llm',    'openai-llm', NULL,         14, 14),
  ('ollama',      'embed',  'openai-embed', NULL,         14, 14),
  ('ollama',      'vision', 'openai-llm', NULL,         14, 14),
  ('lmstudio',    'llm',    'openai-llm', NULL,         15, 15),
  ('lmstudio',    'embed',  'openai-embed', NULL,         15, 15),
  ('siliconflow-cn', 'llm', 'openai-llm', 'siliconflow-cn', 16, 16),
  ('siliconflow-cn', 'embed', 'openai-embed', NULL,       16, 16),
  ('siliconflow-cn', 'rerank', 'cohere-rerank', NULL,     16, 16),
  ('siliconflow-cn', 'vision', 'openai-llm', 'siliconflow-cn', 16, 16),
  ('siliconflow-cn', 'tts', 'siliconflow-tts', NULL,      16, 16),
  ('siliconflow-cn', 'stt', 'openai-stt', NULL,           16, 16),
  ('jina',        'embed',  'openai-embed', NULL,         17, 17),
  ('jina',        'rerank', 'cohere-rerank', NULL,         17, 17),
  ('dashscope',   'tts',    'dashscope-tts', NULL,         18, 18),
  ('gpt-sovits',  'tts',    'gpt-sovits-tts', NULL,         19, 19);

INSERT OR IGNORE INTO provider_protocols
  (provider_id, capability, protocol, base_url, created_at, updated_at) VALUES
  ('openai',      'llm',    'openai-llm',           'https://api.openai.com/v1',                 1, 1),
  ('openai',      'llm',    'openai-responses-llm', 'https://api.openai.com/v1',                 1, 1),
  ('openai',      'embed',  'openai-embed',         'https://api.openai.com/v1',                 1, 1),
  ('openai',      'vision', 'openai-llm',           'https://api.openai.com/v1',                 1, 1),
  ('openai',      'vision', 'openai-responses-llm', 'https://api.openai.com/v1',                 1, 1),
  ('openai',      'stt',    'openai-stt',           'https://api.openai.com/v1',                 1, 1),
  ('anthropic',   'llm',    'anthropic-llm',        'https://api.anthropic.com/v1',              2, 2),
  ('anthropic',   'vision', 'anthropic-llm',        'https://api.anthropic.com/v1',              2, 2),
  ('gemini',      'llm',    'gemini-llm',           'https://generativelanguage.googleapis.com', 3, 3),
  ('gemini',      'vision', 'gemini-llm',           'https://generativelanguage.googleapis.com', 3, 3),
  ('deepseek',    'llm',    'openai-llm',           'https://api.deepseek.com',                  4, 4),
  ('deepseek',    'llm',    'anthropic-llm',        'https://api.deepseek.com/anthropic',        4, 4),
  ('deepseek',    'vision', 'openai-llm',           'https://api.deepseek.com',                  4, 4),
  ('deepseek',    'vision', 'anthropic-llm',        'https://api.deepseek.com/anthropic',        4, 4),
  ('moonshotai-cn', 'llm', 'openai-llm',           'https://api.moonshot.cn/v1',                5, 5),
  ('moonshotai-cn', 'vision', 'openai-llm',        'https://api.moonshot.cn/v1',                5, 5),
  ('zhipu',       'llm',    'openai-llm',           'https://open.bigmodel.cn/api/paas/v4',      6, 6),
  ('zhipu',       'embed',  'openai-embed',         'https://open.bigmodel.cn/api/paas/v4',      6, 6),
  ('zhipu',       'vision', 'openai-llm',           'https://open.bigmodel.cn/api/paas/v4',      6, 6),
  ('openrouter',  'llm',    'openai-llm',           'https://openrouter.ai/api/v1',              7, 7),
  ('openrouter',  'vision', 'openai-llm',           'https://openrouter.ai/api/v1',              7, 7),
  ('groq',        'llm',    'openai-llm',           'https://api.groq.com/openai/v1',            8, 8),
  ('groq',        'vision', 'openai-llm',           'https://api.groq.com/openai/v1',            8, 8),
  ('mistral',     'llm',    'openai-llm',           'https://api.mistral.ai/v1',                 9, 9),
  ('mistral',     'vision', 'openai-llm',           'https://api.mistral.ai/v1',                 9, 9),
  ('xai',         'llm',    'openai-llm',           'https://api.x.ai/v1',                      10, 10),
  ('xai',         'vision', 'openai-llm',           'https://api.x.ai/v1',                      10, 10),
  ('perplexity',  'llm',    'openai-llm',           'https://api.perplexity.ai',                11, 11),
  ('perplexity',  'vision', 'openai-llm',           'https://api.perplexity.ai',                11, 11),
  ('together',    'llm',    'openai-llm',           'https://api.together.xyz/v1',              12, 12),
  ('together',    'embed',  'openai-embed',         'https://api.together.xyz/v1',              12, 12),
  ('together',    'vision', 'openai-llm',           'https://api.together.xyz/v1',              12, 12),
  ('fireworks',   'llm',    'openai-llm',           'https://api.fireworks.ai/inference/v1',    13, 13),
  ('fireworks',   'vision', 'openai-llm',           'https://api.fireworks.ai/inference/v1',    13, 13),
  ('ollama',      'llm',    'openai-llm',           'http://localhost:11434/v1',                14, 14),
  ('ollama',      'embed',  'openai-embed',         'http://localhost:11434/v1',                14, 14),
  ('ollama',      'vision', 'openai-llm',           'http://localhost:11434/v1',                14, 14),
  ('lmstudio',    'llm',    'openai-llm',           'http://localhost:1234/v1',                 15, 15),
  ('lmstudio',    'embed',  'openai-embed',         'http://localhost:1234/v1',                 15, 15),
  ('siliconflow-cn', 'llm', 'openai-llm',          'https://api.siliconflow.cn/v1',            16, 16),
  ('siliconflow-cn', 'embed', 'openai-embed',      'https://api.siliconflow.cn/v1',            16, 16),
  ('siliconflow-cn', 'rerank', 'cohere-rerank',     'https://api.siliconflow.cn/v1',            16, 16),
  ('siliconflow-cn', 'vision', 'openai-llm',       'https://api.siliconflow.cn/v1',            16, 16),
  ('siliconflow-cn', 'tts', 'siliconflow-tts',     'https://api.siliconflow.cn/v1',            16, 16),
  ('siliconflow-cn', 'stt', 'openai-stt',          'https://api.siliconflow.cn/v1',            16, 16),
  ('jina',        'embed',  'openai-embed',         'https://api.jina.ai/v1',                   17, 17),
  ('jina',        'rerank', 'cohere-rerank',        'https://api.jina.ai/v1',                   17, 17),
  ('dashscope',   'tts',    'dashscope-tts',        'https://dashscope.aliyuncs.com',           18, 18),
  ('gpt-sovits',  'tts',    'gpt-sovits-tts',       'http://127.0.0.1:9880',                    19, 19);

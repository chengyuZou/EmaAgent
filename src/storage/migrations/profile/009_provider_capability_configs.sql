-- 将 Provider 的能力开关、协议和连接地址拆成显式关系，停止依赖 capabilities_json 与 config_json。
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

CREATE INDEX idx_provider_capability_enabled
  ON provider_capability_configs(capability, enabled, provider_config_id);

INSERT INTO provider_capability_configs
  (provider_config_id, capability, protocol, base_url, embedding_revision, enabled, created_at, updated_at)
SELECT id, 'llm',
       CASE WHEN json_extract(config_json, '$.protocol') LIKE '%-llm'
            THEN json_extract(config_json, '$.protocol') END,
       base_url, NULL, 1, created_at, updated_at
FROM provider_configs
WHERE capabilities_json LIKE '%"llm"%';

INSERT INTO provider_capability_configs
  (provider_config_id, capability, protocol, base_url, embedding_revision, enabled, created_at, updated_at)
SELECT id, 'embed',
       CASE WHEN json_extract(config_json, '$.protocol') LIKE '%-embed'
            THEN json_extract(config_json, '$.protocol') END,
       base_url, json_extract(config_json, '$.embeddingRevision'), 1, created_at, updated_at
FROM provider_configs
WHERE capabilities_json LIKE '%"embed"%';

INSERT INTO provider_capability_configs
  (provider_config_id, capability, protocol, base_url, embedding_revision, enabled, created_at, updated_at)
SELECT id, 'rerank',
       CASE WHEN json_extract(config_json, '$.protocol') LIKE '%-rerank'
            THEN json_extract(config_json, '$.protocol') END,
       base_url, NULL, 1, created_at, updated_at
FROM provider_configs
WHERE capabilities_json LIKE '%"rerank"%';

INSERT INTO provider_capability_configs
  (provider_config_id, capability, protocol, base_url, embedding_revision, enabled, created_at, updated_at)
SELECT id, 'vision',
       CASE WHEN json_extract(config_json, '$.protocol') LIKE '%-vision'
            THEN json_extract(config_json, '$.protocol') END,
       base_url, NULL, 1, created_at, updated_at
FROM provider_configs
WHERE capabilities_json LIKE '%"vision"%';

INSERT INTO provider_capability_configs
  (provider_config_id, capability, protocol, base_url, embedding_revision, enabled, created_at, updated_at)
SELECT id, 'tts',
       CASE WHEN json_extract(config_json, '$.protocol') LIKE '%-tts'
            THEN json_extract(config_json, '$.protocol') END,
       base_url, NULL, 1, created_at, updated_at
FROM provider_configs
WHERE capabilities_json LIKE '%"tts"%';

INSERT INTO provider_capability_configs
  (provider_config_id, capability, protocol, base_url, embedding_revision, enabled, created_at, updated_at)
SELECT id, 'stt',
       CASE WHEN json_extract(config_json, '$.protocol') LIKE '%-stt'
            THEN json_extract(config_json, '$.protocol') END,
       base_url, NULL, 1, created_at, updated_at
FROM provider_configs
WHERE capabilities_json LIKE '%"stt"%';

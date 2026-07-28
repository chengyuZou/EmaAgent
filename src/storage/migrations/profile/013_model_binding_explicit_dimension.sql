-- model_bindings 只剩 LightRAG Embed 需要额外参数；将万能 JSON 收口为明确维度列。
CREATE TABLE model_bindings_new (
  module             TEXT    NOT NULL
                     CHECK(module IN (
                       'emotion', 'memory',
                       'router', 'plan-parse', 'title',
                       'lightrag-embed', 'lightrag-llm',
                       'tts',
                       'stt', 'vision', 'imagegen'
                     )),
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE RESTRICT,
  model              TEXT    NOT NULL,
  embedding_dimension INTEGER CHECK(embedding_dimension IS NULL OR embedding_dimension > 0),
  PRIMARY KEY (module, provider_config_id, model)
);

INSERT INTO model_bindings_new (
  module,
  provider_config_id,
  model,
  embedding_dimension
)
SELECT
  module,
  provider_config_id,
  model,
  CASE
    WHEN module = 'lightrag-embed'
     AND json_type(config_json, '$.dim') IN ('integer', 'real')
     AND CAST(json_extract(config_json, '$.dim') AS INTEGER) > 0
    THEN CAST(json_extract(config_json, '$.dim') AS INTEGER)
    ELSE NULL
  END
FROM model_bindings;

DROP TABLE model_bindings;
ALTER TABLE model_bindings_new RENAME TO model_bindings;

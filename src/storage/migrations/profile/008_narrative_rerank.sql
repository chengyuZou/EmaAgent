-- 保留已有绑定, 增加剧情重排模块. 不替用户选择供应商或模型.
CREATE TABLE model_bindings_next (
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
INSERT INTO model_bindings_next SELECT * FROM model_bindings;
DROP TABLE model_bindings;
ALTER TABLE model_bindings_next RENAME TO model_bindings;

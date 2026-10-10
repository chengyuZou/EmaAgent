-- 模型绑定的模块名有 CHECK 约束, 改名时保留原绑定并替换表定义.
CREATE TABLE model_bindings_next (
  module TEXT PRIMARY KEY CHECK (module IN (
    'memory-llm', 'narrative-embed', 'narrative-llm', 'tts', 'stt', 'vision'
  )),
  capability TEXT NOT NULL CHECK (capability IN ('llm', 'embed', 'rerank', 'vision', 'tts', 'stt')),
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  CHECK (
    (module IN ('memory-llm', 'narrative-llm') AND capability = 'llm')
    OR (module = 'narrative-embed' AND capability = 'embed')
    OR (module = 'tts' AND capability = 'tts')
    OR (module = 'stt' AND capability = 'stt')
    OR (module = 'vision' AND capability = 'vision')
  ),
  FOREIGN KEY (provider_id, capability, model_id)
    REFERENCES provider_models(provider_id, capability, model_id) ON DELETE CASCADE
);

INSERT INTO model_bindings_next (module, capability, provider_id, model_id)
SELECT CASE module
         WHEN 'lightrag-llm' THEN 'narrative-llm'
         WHEN 'lightrag-embed' THEN 'narrative-embed'
         ELSE module
       END,
       capability, provider_id, model_id
FROM model_bindings;

DROP TABLE model_bindings;
ALTER TABLE model_bindings_next RENAME TO model_bindings;
DELETE FROM settings WHERE key = 'narrative.startOnLaunch';

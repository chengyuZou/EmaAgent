-- ── Split the shared `embed` binding into a dedicated LightRAG embed ───────────
--
-- Before: one `embed` binding fed BOTH the LightRAG bridge (bge-m3) AND the KB
-- kb_search query encoder. Changing it silently wrecked both. Now:
--   - LightRAG gets its own `lightrag-embed` module (pushed to the bridge).
--   - KB embed/rerank move OUT of model_bindings into app settings (kbEmbedModel
--     / kbRerankModel), so the bindings UI no longer exposes generic embed/rerank.
--
-- SQLite can't ALTER a CHECK constraint, so rebuild the table. We ADD
-- 'lightrag-embed' to the CHECK and migrate existing `embed` rows to it (preserve
-- bge-m3). `embed`/`rerank` stay in the CHECK (harmless superset; old rows survive
-- the copy) — the route's Zod enum is the real gate and drops them from the API.

ALTER TABLE model_bindings RENAME TO model_bindings_old;

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

INSERT INTO model_bindings (module, provider_config_id, model, voice_id, config_json)
SELECT CASE WHEN module = 'embed' THEN 'lightrag-embed' ELSE module END,
       provider_config_id, model, voice_id, config_json
FROM model_bindings_old;

DROP TABLE model_bindings_old;

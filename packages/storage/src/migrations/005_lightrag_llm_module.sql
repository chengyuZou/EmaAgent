-- ── Migration 005: add 'lightrag-llm' to model_bindings CHECK ────────────────
--
-- LightRAG needs its own dedicated LLM binding for internal graph operations
-- (entity extraction, relation building) — separate from the user-facing
-- 'narrative' binding which drives the chat response.
--
-- Also adds 'title' which was missing from the 004 CHECK.

CREATE TABLE model_bindings_v5 (
  module             TEXT    PRIMARY KEY
                     CHECK(module IN (
                       -- TS-side LLM modules
                       'chat', 'narrative', 'agent',
                       'compaction', 'emotion',
                       'router', 'plan-parse', 'title',
                       -- LightRAG internal config (pushed to Python bridge)
                       'embed', 'rerank', 'lightrag-llm',
                       -- Future TS-side clients (reserved)
                       'tts', 'stt', 'vision', 'imagegen'
                     )),
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE RESTRICT,
  model              TEXT    NOT NULL,
  voice_id           TEXT,
  config_json        TEXT    NOT NULL DEFAULT '{}'
);

INSERT INTO model_bindings_v5 SELECT * FROM model_bindings;

DROP TABLE  model_bindings;
ALTER TABLE model_bindings_v5 RENAME TO model_bindings;

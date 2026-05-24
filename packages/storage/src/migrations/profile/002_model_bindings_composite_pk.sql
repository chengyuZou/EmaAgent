-- ── Fix model_bindings primary key ───────────────────────────────────────────
--
-- V1 migration 001 was deployed with `module TEXT PRIMARY KEY` (single column).
-- The repo code expects PRIMARY KEY (module, provider_config_id, model) so that
-- each module can have multiple candidate bindings and the UPSERT ON CONFLICT
-- clause matches.  This migration recreates the table with the correct PK.
--
-- Safe to run on an empty table (no bindings are ever written before this fix),
-- but we preserve any existing rows just in case.

PRAGMA foreign_keys = OFF;

CREATE TABLE model_bindings_v2 (
  module             TEXT    NOT NULL
                     CHECK(module IN (
                       'chat', 'narrative', 'agent',
                       'compaction', 'emotion', 'memory',
                       'router', 'plan-parse', 'title',
                       'embed', 'rerank', 'lightrag-llm',
                       'tts_chat', 'tts_narrative', 'tts_agent',
                       'stt', 'vision', 'imagegen'
                     )),
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE RESTRICT,
  model              TEXT    NOT NULL,
  voice_id           TEXT,
  config_json        TEXT    NOT NULL DEFAULT '{}',
  PRIMARY KEY (module, provider_config_id, model)
);

INSERT INTO model_bindings_v2
  SELECT module, provider_config_id, model, voice_id, config_json
  FROM   model_bindings;

DROP TABLE model_bindings;
ALTER TABLE model_bindings_v2 RENAME TO model_bindings;

PRAGMA foreign_keys = ON;

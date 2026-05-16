-- ── Migration 003: model_bindings v2 + model_catalog protocol rename ─────────
--
-- Changes:
--   1. model_bindings: drop FK to model_catalog, add provider_config_id + model.
--      A binding now says "for this module use THIS provider instance with THIS model",
--      which is the only way to support e.g. narrative→deepseek-reasoner AND
--      agent→siliconflow/Qwen at the same time.
--   2. model_catalog: rename llm_provider column → protocol, update CHECK values
--      to match the new ProtocolFamily names (openai-llm / anthropic-llm / gemini-llm).
--      model_catalog is kept as a static curated list for the UI model picker;
--      it is no longer referenced by model_bindings.
--
-- SQLite has no ALTER COLUMN, so both tables are recreated via the
-- rename-shadow pattern (create new → copy data → drop old → rename).

-- ── Step 1: rebuild model_bindings ───────────────────────────────────────────

CREATE TABLE model_bindings_v2 (
  module             TEXT    PRIMARY KEY
                     CHECK(module IN (
                       'chat','narrative','agent',
                       'compaction','emotion',
                       'tts','stt','vision','imagegen',
                       'router','plan-parse'
                     )),
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE RESTRICT,
  model              TEXT    NOT NULL,
  -- voice_id is only meaningful for tts bindings; NULL for all LLM modules.
  voice_id           TEXT,
  config_json        TEXT    NOT NULL DEFAULT '{}'
);

-- No data migration: old bindings referenced model_catalog rows that no longer
-- carry instance identity.  Bindings must be re-set by the user (or seeded by
-- the setup wizard) after this migration.

DROP TABLE model_bindings;
ALTER TABLE model_bindings_v2 RENAME TO model_bindings;

-- ── Step 2: rebuild model_catalog with corrected protocol values ───────────

CREATE TABLE model_catalog_v2 (
  id                TEXT    PRIMARY KEY,
  -- Wire-format protocol this model is served over.
  -- Renamed from llm_provider; values updated to match ProtocolFamily.
  protocol          TEXT    NOT NULL
                    CHECK(protocol IN ('openai-llm','anthropic-llm','gemini-llm')),
  display_name      TEXT    NOT NULL,
  capabilities_json TEXT    NOT NULL,
  context_window    INTEGER NOT NULL,
  pricing_json      TEXT,
  is_static         INTEGER NOT NULL DEFAULT 0,
  enabled           INTEGER NOT NULL DEFAULT 1,
  fetched_at        INTEGER
);

-- Map old llm_provider values → new protocol names.
INSERT INTO model_catalog_v2
  SELECT
    id,
    CASE llm_provider
      WHEN 'openai'        THEN 'openai-llm'
      WHEN 'openai-compat' THEN 'openai-llm'
      WHEN 'anthropic'     THEN 'anthropic-llm'
      WHEN 'gemini'        THEN 'gemini-llm'
      -- Unknown values: skip (WHERE clause below filters them out)
    END,
    display_name,
    capabilities_json,
    context_window,
    pricing_json,
    is_static,
    enabled,
    fetched_at
  FROM model_catalog
  WHERE llm_provider IN ('openai','openai-compat','anthropic','gemini');

DROP TABLE model_catalog;
ALTER TABLE model_catalog_v2 RENAME TO model_catalog;

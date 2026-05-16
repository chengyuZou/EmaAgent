-- ── Migration 004: merge capability_bindings into model_bindings ─────────────
--
-- capability_bindings is redundant — it's the same structure as model_bindings
-- (module → provider_config_id + model + params).  Merging eliminates the
-- artificial split between "LLM modules" and "non-LLM capabilities".
--
-- Also adds the missing modules to model_bindings CHECK:
--   'embed', 'rerank'  ← moved from capability_bindings
--   'title'            ← new LLM module for session title generation

-- ── Step 1: rebuild model_bindings with the full module set ──────────────────

CREATE TABLE model_bindings_v4 (
  module             TEXT    PRIMARY KEY
                     CHECK(module IN (
                       -- LLM modules (TS-side LlmRouter)
                       'chat', 'narrative', 'agent',
                       'compaction', 'emotion',
                       'router', 'plan-parse', 'title',
                       -- Bridge-side capabilities (Python FastAPI)
                       'embed', 'rerank',
                       'tts', 'stt', 'vision', 'imagegen'
                     )),
  provider_config_id TEXT    NOT NULL REFERENCES provider_configs(id) ON DELETE RESTRICT,
  model              TEXT    NOT NULL,
  voice_id           TEXT,
  config_json        TEXT    NOT NULL DEFAULT '{}'
);

-- Carry over all existing LLM module bindings.
INSERT INTO model_bindings_v4 SELECT * FROM model_bindings;

-- Migrate enabled capability_bindings rows.
-- params_json becomes config_json; voice_id has no equivalent → NULL.
INSERT OR IGNORE INTO model_bindings_v4
  (module, provider_config_id, model, voice_id, config_json)
  SELECT capability, provider_config_id, model, NULL, params_json
  FROM   capability_bindings
  WHERE  enabled = 1;

DROP TABLE  model_bindings;
ALTER TABLE model_bindings_v4 RENAME TO model_bindings;

-- ── Step 2: drop capability_bindings (was created in migration 002) ───────────

DROP TABLE IF EXISTS capability_bindings;

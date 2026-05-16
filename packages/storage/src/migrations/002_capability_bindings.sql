-- Migration 002: capability bindings for non-LLM modalities
--
-- Singleton binding per capability — one active embed / rerank / vision model.
-- provider_config_id references the connection info (api_key + base_url),
-- so the same SiliconFlow account can serve multiple capabilities without
-- duplicating credentials.

CREATE TABLE IF NOT EXISTS capability_bindings (
  capability         TEXT PRIMARY KEY
                     CHECK(capability IN ('embed','rerank','vision')),
  provider_config_id TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model              TEXT NOT NULL,
  -- Capability-specific params:
  --   embed:  {"dim": 1024}
  --   rerank: {}
  --   vision: {"detail": "auto"}
  params_json        TEXT NOT NULL DEFAULT '{}',
  enabled            INTEGER NOT NULL DEFAULT 0
);

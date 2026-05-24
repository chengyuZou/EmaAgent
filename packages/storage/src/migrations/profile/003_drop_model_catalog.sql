-- 003: Drop unused model_catalog table.
--
-- model_catalog was intended as a managed model directory but was never wired
-- to a Repo.  Its CHECK constraint also held stale llm_provider values
-- ('openai','anthropic','gemini','openai-compat') that don't match the
-- current ProtocolFamily names ('openai-llm' etc.).  Model metadata lives
-- in ProviderDefinition.defaultModels (in-memory) and model_bindings
-- (per-module, per-provider-config); model_catalog is dead schema.
DROP TABLE IF EXISTS model_catalog;

INSERT INTO usage_records (
  id,
  session_id,
  turn_id,
  provider_id,
  model_id,
  capability,
  status,
  input_tokens,
  output_tokens,
  cache_read_input_tokens,
  cache_write_input_tokens,
  quantity,
  unit,
  duration_ms,
  error_code,
  created_at
)
SELECT
  'migrated-turn-usage:' || t.id,
  t.session_id,
  t.id,
  t.provider_id,
  t.model_id,
  'llm',
  'completed',
  t.usage_input_tokens,
  t.usage_output_tokens,
  NULL,
  NULL,
  NULL,
  NULL,
  MAX(COALESCE(t.completed_at, t.created_at) - t.created_at, 0),
  NULL,
  COALESCE(t.completed_at, t.created_at)
FROM turns AS t
WHERE (t.usage_input_tokens > 0 OR t.usage_output_tokens > 0)
  AND NOT EXISTS (
    SELECT 1
    FROM usage_records AS usage
    WHERE usage.turn_id = t.id
      AND usage.capability = 'llm'
  );

ALTER TABLE turns DROP COLUMN usage_input_tokens;
ALTER TABLE turns DROP COLUMN usage_output_tokens;

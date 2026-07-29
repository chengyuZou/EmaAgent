-- 023: 区分用户取消与 Provider 失败，避免取消调用污染失败率和故障诊断。
CREATE TABLE usage_records_v23 (
  id                       TEXT PRIMARY KEY,
  session_id               TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id                  TEXT REFERENCES turns(id) ON DELETE CASCADE,
  provider_id              TEXT NOT NULL,
  model_id                 TEXT NOT NULL,
  capability               TEXT NOT NULL CHECK (capability IN ('llm','vision','embed','rerank','stt','tts')),
  status                   TEXT NOT NULL CHECK (status IN ('completed','failed','cancelled')),
  input_tokens             INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens            INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_input_tokens  INTEGER CHECK (cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0),
  cache_write_input_tokens INTEGER CHECK (cache_write_input_tokens IS NULL OR cache_write_input_tokens >= 0),
  quantity                 REAL CHECK (quantity IS NULL OR quantity >= 0),
  unit                     TEXT,
  cost_usd                 REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  duration_ms              INTEGER NOT NULL CHECK (duration_ms >= 0),
  error_code               TEXT,
  created_at               INTEGER NOT NULL,
  CHECK ((quantity IS NULL AND unit IS NULL) OR (quantity IS NOT NULL AND unit IS NOT NULL))
);

INSERT INTO usage_records_v23 (
  id, session_id, turn_id, provider_id, model_id, capability, status,
  input_tokens, output_tokens, cache_read_input_tokens, cache_write_input_tokens,
  quantity, unit, cost_usd, duration_ms, error_code, created_at
)
SELECT
  id, session_id, turn_id, provider_id, model_id, capability, status,
  input_tokens, output_tokens, cache_read_input_tokens, cache_write_input_tokens,
  quantity, unit, cost_usd, duration_ms, error_code, created_at
FROM usage_records;

DROP TABLE usage_records;
ALTER TABLE usage_records_v23 RENAME TO usage_records;

CREATE INDEX idx_usage_records_turn ON usage_records(turn_id, created_at, id);
CREATE INDEX idx_usage_records_session ON usage_records(session_id, created_at, id);
CREATE INDEX idx_usage_records_created ON usage_records(created_at, id);

CREATE TRIGGER trg_usage_records_turn_session_insert
BEFORE INSERT ON usage_records
WHEN NEW.turn_id IS NOT NULL
 AND NEW.session_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
 )
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: usage_records.turn_id');
END;

CREATE TRIGGER trg_usage_records_turn_session_update
BEFORE UPDATE OF turn_id, session_id ON usage_records
WHEN NEW.turn_id IS NOT NULL
 AND NEW.session_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
 )
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: usage_records.turn_id');
END;

-- 013: 把 Turn 级 LLM 汇总表迁成调用级通用用量账本，允许同一 Turn 记录多次模型调用。
CREATE TABLE usage_records (
  id                       TEXT PRIMARY KEY,
  session_id               TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id                  TEXT REFERENCES turns(id) ON DELETE CASCADE,
  provider_id              TEXT NOT NULL,
  model_id                 TEXT NOT NULL,
  capability               TEXT NOT NULL CHECK (capability IN ('llm','vision','embed','rerank','stt','tts')),
  status                   TEXT NOT NULL CHECK (status IN ('completed','failed')),
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

-- 旧表中的 provider 值是协议名而非配置 ID，只能明确标记为历史来源，不能伪装成真实 Provider。
INSERT INTO usage_records (
  id, session_id, turn_id, provider_id, model_id, capability, status,
  input_tokens, output_tokens, cost_usd, duration_ms, created_at
)
SELECT
  'legacy:' || m.turn_id, t.session_id, m.turn_id, 'legacy-protocol:' || m.llm_provider,
  m.model_id, 'llm', 'completed', m.input_tokens, m.output_tokens,
  m.cost_usd, m.duration_ms, m.created_at
FROM llm_turn_metrics m
JOIN turns t ON t.id = m.turn_id;

DROP TABLE llm_turn_metrics;

CREATE INDEX idx_usage_records_turn ON usage_records(turn_id, created_at, id);
CREATE INDEX idx_usage_records_session ON usage_records(session_id, created_at, id);
CREATE INDEX idx_usage_records_created ON usage_records(created_at, id);

-- 同时携带 Session 与 Turn 时必须属于同一会话，防止统计和备份跨 Session 串线。
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

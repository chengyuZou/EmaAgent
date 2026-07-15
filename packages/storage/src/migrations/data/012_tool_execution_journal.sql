-- B-010：工具副作用必须先写入持久化执行日志，再跨越权限和执行边界。
-- Session 消息只是展示投影；本表才是崩溃恢复和审计的事实来源。

CREATE TABLE tool_executions (
  call_id        TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id        TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  tool_name      TEXT NOT NULL,
  input_json     TEXT NOT NULL,
  input_digest   TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN (
    'prepared', 'authorized', 'running', 'succeeded',
    'failed', 'cancelled', 'outcome_unknown'
  )),
  result_preview TEXT,
  error_code     TEXT,
  error_message  TEXT,
  started_at     INTEGER,
  completed_at   INTEGER,
  version        INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX idx_tool_executions_turn
  ON tool_executions(turn_id, created_at, call_id);

CREATE INDEX idx_tool_executions_recovery
  ON tool_executions(status, updated_at, call_id);

-- turn_id 必须属于同一 session，避免一条日志串到别的会话。
CREATE TRIGGER trg_tool_executions_owner_insert
BEFORE INSERT ON tool_executions
WHEN NOT EXISTS (
  SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: tool_executions.turn_id');
END;

-- 调用身份一旦创建不可修改；状态只能由 CAS 更新推进。
CREATE TRIGGER trg_tool_executions_owner_update
BEFORE UPDATE OF call_id, session_id, turn_id, tool_name, input_json, input_digest
ON tool_executions
BEGIN
  SELECT CASE
    WHEN NEW.call_id <> OLD.call_id
      OR NEW.session_id <> OLD.session_id
      OR NEW.turn_id <> OLD.turn_id
      OR NEW.tool_name <> OLD.tool_name
      OR NEW.input_json <> OLD.input_json
      OR NEW.input_digest <> OLD.input_digest
    THEN RAISE(ABORT, 'ownership_violation: tool execution identity is immutable')
  END;
END;

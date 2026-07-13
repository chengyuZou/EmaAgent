-- 009: 为同毫秒事件建立确定顺序。
--
-- AgentTask transcript 具有严格因果顺序，随机 UUID 只能提供稳定但任意的
-- 排序，因此增加 task 内单调 sequence。旧数据无法恢复真实因果顺序，只能按
-- 既有 created_at + id 确定性回填；新数据从写入时开始保留真实顺序。

ALTER TABLE agent_task_messages RENAME TO agent_task_messages_v8;

CREATE TABLE agent_task_messages (
  id           TEXT    PRIMARY KEY,
  task_id      TEXT    NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  role         TEXT    NOT NULL CHECK (role IN ('assistant','tool_call','tool_result','reasoning')),
  content_json TEXT    NOT NULL,
  sequence     INTEGER NOT NULL CHECK (sequence > 0),
  created_at   INTEGER NOT NULL
);

INSERT INTO agent_task_messages
  (id, task_id, role, content_json, sequence, created_at)
SELECT
  id,
  task_id,
  role,
  content_json,
  ROW_NUMBER() OVER (
    PARTITION BY task_id
    ORDER BY created_at ASC, id ASC
  ),
  created_at
FROM agent_task_messages_v8;

DROP TABLE agent_task_messages_v8;

CREATE UNIQUE INDEX idx_atm_task_sequence
  ON agent_task_messages(task_id, sequence ASC);

DROP INDEX idx_pending_fragments_session;
CREATE INDEX idx_pending_fragments_session
  ON pending_fragments(session_id, at ASC, created_at ASC, id ASC);

DROP INDEX idx_telemetry_kind;
CREATE INDEX idx_telemetry_kind
  ON telemetry_events(kind, created_at DESC, id DESC);

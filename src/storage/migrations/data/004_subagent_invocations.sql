CREATE TABLE subagent_invocations (
  tool_call_id TEXT PRIMARY KEY,
  subagent_id TEXT NOT NULL REFERENCES subagents(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_subagent_invocations_subagent
  ON subagent_invocations(subagent_id, created_at ASC, tool_call_id ASC);

-- 旧记录曾共用 ToolCallId 与 SubagentId, 升级时保留历史卡片的导航关系.
INSERT INTO subagent_invocations (tool_call_id, subagent_id, created_at)
SELECT id, id, created_at FROM subagents;

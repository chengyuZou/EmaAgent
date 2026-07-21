-- B-056：AgentTask 使用单调递增版本号进行乐观并发控制。
-- 历史行从 version=0 开始；后续每次合法状态转换都必须 version + 1。
ALTER TABLE agent_tasks
  ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);

-- L0 节点溯源链：记录每个记忆节点的事实来自哪些 Session/Turn。
-- 节点与来源是多对多（同一节点可经多次提取/lazy update 累积证据），故用关联表而非节点列。
-- 跨库软引用：sessions/turns 在 data.db，不能建 FK；Session 删除后来源行保留为历史记录。
-- source_turn_id 不允许 NULL：SQLite rowid 表的 PK 列里 NULL 互不相等，会破坏 INSERT OR IGNORE 去重。
CREATE TABLE memory_node_sources (
  node_id           TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL,
  source_turn_id    TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (node_id, source_session_id, source_turn_id)
);

CREATE INDEX idx_memory_node_sources_node ON memory_node_sources(node_id, created_at);

-- 存量回填：lazy_updates 缓冲区已记录的来源迁入溯源表；无来源信息的旧节点留空，不伪造。
INSERT OR IGNORE INTO memory_node_sources (node_id, source_session_id, source_turn_id, created_at)
SELECT node_id, source_session_id, COALESCE(source_turn_id, ''), MIN(created_at)
FROM memory_node_lazy_updates
WHERE source_session_id IS NOT NULL
GROUP BY node_id, source_session_id, source_turn_id;

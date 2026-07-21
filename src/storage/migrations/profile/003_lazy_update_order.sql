-- 003: 同毫秒的惰性记忆更新使用 id 作为稳定次序，避免 Consolidation
-- 在不同查询计划下收到顺序漂移的 fragment。

DROP INDEX idx_lazy_updates_node;
CREATE INDEX idx_lazy_updates_node
  ON memory_node_lazy_updates(node_id, created_at ASC, id ASC);

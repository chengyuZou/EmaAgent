-- 记录每条全局 Memory 最近一次自动衰减时间，避免重启或频繁空闲扫描重复扣减重要度。

ALTER TABLE memory_nodes ADD COLUMN last_decayed_at INTEGER;
ALTER TABLE memory_items ADD COLUMN last_decayed_at INTEGER;

CREATE INDEX idx_memory_nodes_decay
  ON memory_nodes(last_referenced_at ASC, last_decayed_at ASC, id ASC)
  WHERE importance > 0;

CREATE INDEX idx_memory_items_decay
  ON memory_items(last_referenced_at ASC, last_decayed_at ASC, id ASC)
  WHERE importance > 0;

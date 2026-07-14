-- B-049：Memory 旧向量只有部分 provenance。space_id 保持 NULL，
-- 查询与索引重建只读取精确空间，因此旧向量会安全退出并等待刷新。

ALTER TABLE memory_nodes ADD COLUMN embedding_normalization TEXT;
ALTER TABLE memory_nodes ADD COLUMN embedding_revision TEXT;
ALTER TABLE memory_nodes ADD COLUMN embedding_space_id TEXT;

ALTER TABLE memory_items ADD COLUMN embedding_normalization TEXT;
ALTER TABLE memory_items ADD COLUMN embedding_revision TEXT;
ALTER TABLE memory_items ADD COLUMN embedding_space_id TEXT;

CREATE INDEX idx_memory_nodes_embedding_space
  ON memory_nodes(embedding_space_id, updated_at, id)
  WHERE embedding IS NOT NULL;
CREATE INDEX idx_memory_items_embedding_space
  ON memory_items(embedding_space_id, updated_at, id)
  WHERE embedding IS NOT NULL;

-- B-049：旧 KB 向量缺少 Provider/归一化/Revision，无法安全推断空间。
-- 不回填猜测值；迁移后旧向量退出 dense retrieval，等待显式重嵌。

ALTER TABLE document_assets ADD COLUMN ebd_provider_id TEXT;
ALTER TABLE document_assets ADD COLUMN ebd_normalization TEXT;
ALTER TABLE document_assets ADD COLUMN ebd_revision TEXT;
ALTER TABLE document_assets ADD COLUMN ebd_space_id TEXT;

ALTER TABLE document_chunks ADD COLUMN embedding_space_id TEXT;

UPDATE document_assets
SET ebd_stale = 1
WHERE EXISTS (
  SELECT 1 FROM document_chunks dc
  WHERE dc.asset_id = document_assets.id AND dc.embedding IS NOT NULL
);

CREATE INDEX idx_doc_assets_ebd_space
  ON document_assets(ebd_space_id, ebd_stale);
CREATE INDEX idx_doc_chunks_embedding_space
  ON document_chunks(embedding_space_id)
  WHERE embedding IS NOT NULL;

-- B-060：文档列表使用 (created_at, id) 复合 keyset cursor。
-- 替换旧单列索引，避免同毫秒记录分页时额外排序或遗漏。
DROP INDEX idx_doc_assets_created;
CREATE INDEX idx_doc_assets_created
  ON document_assets(created_at DESC, id DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- KB 流--每个命名 knowledge base 一个 kb.db。
--
-- 每个命名 KB(注册在 profile.db.knowledge_bases)是一个自包含文件夹,
-- 存放此 kb.db + 一个 files/ 目录(复制的原件)。这里没有任何东西引用
-- session/turn--那些在 data.db。"哪个 session 用了哪个 KB 文档"由
-- data.db.kb_activations 追踪(通过裸 kb_id/asset_id)。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 文档 ──────────────────────────────────────────────────────────────────────────

CREATE TABLE document_assets (
  id                TEXT    PRIMARY KEY,
  file_path         TEXT    NOT NULL,        -- 复制原件的路径(相对 {kb}/files)
  file_name         TEXT    NOT NULL,
  mime_type         TEXT    NOT NULL,
  title             TEXT,
  word_count        INTEGER NOT NULL DEFAULT 0,
  page_count        INTEGER,
  status            TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'indexing', 'indexed', 'error')),
  content_hash      TEXT,
  ebd_model         TEXT,                    -- 该文档被索引时使用的 embedding 模型
  ebd_dim           INTEGER,
  ebd_stale         INTEGER NOT NULL DEFAULT 0,
  use_count         INTEGER NOT NULL DEFAULT 0,
  last_activated_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_doc_assets_status    ON document_assets(status);
CREATE INDEX idx_doc_assets_hash      ON document_assets(content_hash);
CREATE INDEX idx_doc_assets_ebd_stale ON document_assets(ebd_stale) WHERE ebd_stale = 1;
CREATE INDEX idx_doc_assets_created   ON document_assets(created_at DESC);
CREATE INDEX idx_doc_assets_lastact   ON document_assets(last_activated_at);

CREATE TABLE document_chunks (
  id                TEXT    PRIMARY KEY,
  asset_id          TEXT    NOT NULL REFERENCES document_assets(id) ON DELETE CASCADE,
  text              TEXT    NOT NULL,
  tokens            TEXT    NOT NULL DEFAULT '',   -- jieba 分词副本,喂给 FTS5
  markdown          TEXT,
  block_kinds_json  TEXT    NOT NULL DEFAULT '[]',
  token_count       INTEGER NOT NULL DEFAULT 0,
  page              INTEGER,
  section_path_json TEXT    NOT NULL DEFAULT '[]',
  prev_id           TEXT,
  next_id           TEXT,
  mom_id            TEXT,                          -- 父("mom")窗口 id(small-to-big)
  mom_text          TEXT,                          -- 每个子块携带的完整父窗口文本
  embedding         BLOB                           -- Float32 二进制:4 bytes × dim
);

CREATE INDEX idx_doc_chunks_asset ON document_chunks(asset_id);
CREATE INDEX idx_doc_chunks_mom   ON document_chunks(mom_id);

CREATE TABLE document_previews (
  asset_id        TEXT    PRIMARY KEY REFERENCES document_assets(id) ON DELETE CASCADE,
  text            TEXT    NOT NULL DEFAULT '',
  thumbnail       BLOB,
  thumbnail_mime  TEXT,
  page_count      INTEGER,
  word_count      INTEGER NOT NULL DEFAULT 0
);

-- ── FTS5(jieba 分词 BM25)──────────────────────────────────────────────────────
-- `tokens` 存 jieba 分词文本;trigger 保持索引同步。

CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  tokens,
  chunk_id  UNINDEXED,
  asset_id  UNINDEXED,
  tokenize  = 'unicode61 remove_diacritics 1'
);

CREATE TRIGGER doc_chunks_fts_ai
AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(rowid, tokens, chunk_id, asset_id)
  VALUES (NEW.rowid, NEW.tokens, NEW.id, NEW.asset_id);
END;

CREATE TRIGGER doc_chunks_fts_ad
AFTER DELETE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER doc_chunks_fts_au
AFTER UPDATE OF tokens ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE rowid = OLD.rowid;
  INSERT INTO document_chunks_fts(rowid, tokens, chunk_id, asset_id)
  VALUES (NEW.rowid, NEW.tokens, NEW.id, NEW.asset_id);
END;

-- ── Ingest 队列(per-KB 后台索引)─────────────────────────────────────────────────

CREATE TABLE kb_ingest_tasks (
  id          TEXT    PRIMARY KEY,
  file_path   TEXT    NOT NULL,
  file_name   TEXT    NOT NULL,
  mime_type   TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'running', 'failed')),
  stage       TEXT,
  progress    REAL    NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_kb_ingest_status ON kb_ingest_tasks(status, created_at);

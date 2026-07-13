-- 通用 Session 消息全文搜索投影。
-- messages 是事实表；普通表保存可检查的纯文本/tokens，FTS5 只保存倒排索引。
CREATE TABLE message_search_documents (
  message_id  TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  session_id  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  text        TEXT    NOT NULL,
  tokens      TEXT    NOT NULL
);

CREATE INDEX idx_message_search_documents_session
  ON message_search_documents(session_id, created_at DESC, message_id DESC);

CREATE VIRTUAL TABLE message_search_fts USING fts5(
  tokens,
  message_id UNINDEXED,
  session_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 1'
);

-- documents 是唯一同步入口，保证回填、消息 trigger 与未来维护命令行为一致。
CREATE TRIGGER message_search_fts_ai
AFTER INSERT ON message_search_documents BEGIN
  INSERT INTO message_search_fts(rowid, tokens, message_id, session_id)
  VALUES (NEW.rowid, NEW.tokens, NEW.message_id, NEW.session_id);
END;

CREATE TRIGGER message_search_fts_ad
AFTER DELETE ON message_search_documents BEGIN
  DELETE FROM message_search_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER message_search_fts_au
AFTER UPDATE OF tokens, session_id ON message_search_documents BEGIN
  DELETE FROM message_search_fts WHERE rowid = OLD.rowid;
  INSERT INTO message_search_fts(rowid, tokens, message_id, session_id)
  VALUES (NEW.rowid, NEW.tokens, NEW.message_id, NEW.session_id);
END;

-- 只索引通用对话与摘要；隐藏 context、persona、tool_results、narrative_context 不进入索引。
CREATE TRIGGER messages_search_ai
AFTER INSERT ON messages
WHEN NEW.kind IN ('normal', 'summary') BEGIN
  INSERT INTO message_search_documents(message_id, session_id, created_at, text, tokens)
  VALUES (
    NEW.id,
    NEW.session_id,
    NEW.created_at,
    ema_message_search_text(NEW.blocks_json),
    ema_segment_fts(ema_message_search_text(NEW.blocks_json))
  );
END;

CREATE TRIGGER messages_search_au
AFTER UPDATE OF blocks_json, kind, session_id, created_at ON messages BEGIN
  DELETE FROM message_search_documents WHERE message_id = OLD.id;
  INSERT INTO message_search_documents(message_id, session_id, created_at, text, tokens)
  SELECT
    NEW.id,
    NEW.session_id,
    NEW.created_at,
    ema_message_search_text(NEW.blocks_json),
    ema_segment_fts(ema_message_search_text(NEW.blocks_json))
  WHERE NEW.kind IN ('normal', 'summary');
END;

-- 对升级前已有消息做一次确定性回填；之后全部由 trigger 同步。
INSERT INTO message_search_documents(message_id, session_id, created_at, text, tokens)
SELECT
  id,
  session_id,
  created_at,
  ema_message_search_text(blocks_json),
  ema_segment_fts(ema_message_search_text(blocks_json))
FROM messages
WHERE kind IN ('normal', 'summary');

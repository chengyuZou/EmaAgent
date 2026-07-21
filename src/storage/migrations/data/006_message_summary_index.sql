-- 压缩历史只需要定位每个 session 最新的一条 summary。
-- 部分索引避免在大量普通消息中反向扫描，同时保持索引体积最小。
CREATE INDEX idx_messages_session_latest_summary
  ON messages(session_id, created_at DESC, id DESC)
  WHERE kind = 'summary';

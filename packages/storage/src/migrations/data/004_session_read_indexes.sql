-- Session 读取投影的稳定排序索引。
-- 三个索引分别服务 session keyset、latest-turn 窗口和匹配消息窗口。
CREATE INDEX idx_sessions_activity
  ON sessions(pinned DESC, last_activity_at DESC, id DESC);

CREATE INDEX idx_turns_session_latest
  ON turns(session_id, started_at DESC, id DESC);

CREATE INDEX idx_turns_running_by_session
  ON turns(session_id)
  WHERE status = 'running';

CREATE INDEX idx_messages_session_latest
  ON messages(session_id, created_at DESC, id DESC);

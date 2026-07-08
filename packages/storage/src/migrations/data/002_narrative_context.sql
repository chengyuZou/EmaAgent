-- 002: messages.kind 加 'narrative_context'(narrative 检索块持久化)
--
-- 背景:narrative 模式 beforeLlm hook 检索剧情线结果,需要落盘成独立 message
-- (kind=narrative_context),既回灌 LLM(多轮 narrative 不丢上下文)又前端显示
-- 成检索块气泡。现有 kind 没有既"发给 LLM + 显示成检索块"的语义,需加新值。
--
-- SQLite 不能直接 ALTER CHECK 约束,用"重命名旧表 -> 建新表(新 CHECK)
-- -> 拷贝数据 -> 删旧表"四步。幂等:新装 DB 跑 001(旧 CHECK)+ 002(重建);
-- 旧 DB 跑 002 重建。数据完整保留(INSERT ... SELECT *)。
--
-- 表结构跟 001 完全一致,仅 kind CHECK 多 'narrative_context'。

ALTER TABLE messages RENAME TO messages_old;

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id     TEXT REFERENCES turns(id) ON DELETE SET NULL,
  role        TEXT NOT NULL CHECK(role IN ('system','user','assistant')),
  kind        TEXT NOT NULL DEFAULT 'normal'
              CHECK(kind IN ('normal','context','tool_results','summary','persona_reminder','narrative_context')),
  blocks_json TEXT NOT NULL,
  interrupted INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  meta_json   TEXT NOT NULL DEFAULT '{}'
);

-- RENAME 表时旧索引仍指向旧表(messages_old),同名索引会冲突,先删再建。
DROP INDEX IF EXISTS idx_messages_session;
DROP INDEX IF EXISTS idx_messages_turn;
CREATE INDEX idx_messages_session ON messages(session_id, created_at);
CREATE INDEX idx_messages_turn    ON messages(turn_id);

INSERT INTO messages SELECT * FROM messages_old;

DROP TABLE messages_old;

-- Memory 提取跨 profile.db / data.db 提交时的短期恢复标记。
-- profile 写入与本行在同一事务提交；data 写入完成后删除本行。
CREATE TABLE memory_extraction_runs (
  run_id               TEXT PRIMARY KEY CHECK(length(run_id) > 0),
  session_id           TEXT NOT NULL CHECK(length(session_id) > 0),
  source_turn_id       TEXT NOT NULL CHECK(length(source_turn_id) > 0),
  note_delta           TEXT NOT NULL,
  nodes_count          INTEGER NOT NULL CHECK(nodes_count >= 0),
  edges_count          INTEGER NOT NULL CHECK(edges_count >= 0),
  items_count          INTEGER NOT NULL CHECK(items_count >= 0),
  lazy_updates_count   INTEGER NOT NULL CHECK(lazy_updates_count >= 0),
  committed_at         INTEGER NOT NULL
);

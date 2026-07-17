-- B-075：KB 重建索引(re-embed)从路由同步 await 改为持久后台任务。
-- 结构与 kb_ingest_tasks 同型(lease + version CAS + attempt + 失败分片)；
-- asset_id 为 NULL 表示全库 stale 扫描，有值表示单文档重建。

CREATE TABLE kb_reembed_tasks (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT,
  ebd_provider_id  TEXT NOT NULL,
  ebd_model        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'running', 'failed', 'partial_failed', 'cancelled')),
  stage            TEXT,
  progress         REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  error_code       TEXT,
  error            TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  version          INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  lease_token      TEXT,
  lease_expires_at INTEGER,
  next_retry_at    INTEGER NOT NULL DEFAULT 0,
  total_items      INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  completed_items  INTEGER NOT NULL DEFAULT 0 CHECK (completed_items >= 0),
  failed_items     INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX idx_kb_reembed_ready
  ON kb_reembed_tasks(status, next_retry_at, created_at, id);

CREATE INDEX idx_kb_reembed_lease
  ON kb_reembed_tasks(status, lease_expires_at, id);

-- 单资产失败明细：任务整体继续，失败资产留 stale 标记供下一场扫描重试。
CREATE TABLE kb_reembed_failure_shards (
  task_id       TEXT NOT NULL REFERENCES kb_reembed_tasks(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL CHECK (stage IN ('embed')),
  shard_key     TEXT NOT NULL,
  item_ids_json TEXT NOT NULL DEFAULT '[]',
  retryable     INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
  error_code    TEXT,
  error         TEXT NOT NULL,
  attempt       INTEGER NOT NULL CHECK (attempt >= 1),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (task_id, stage, shard_key)
);

CREATE INDEX idx_kb_reembed_failures_task
  ON kb_reembed_failure_shards(task_id, stage, shard_key);

-- B-011/B-012：任务身份与文档身份分离，并为持久队列增加 CAS、租约、
-- 尝试次数和失败分片。旧表没有外部 FK，可以安全重建并原样迁移失败任务。

ALTER TABLE kb_ingest_tasks RENAME TO kb_ingest_tasks_legacy;

CREATE TABLE kb_ingest_tasks (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT NOT NULL,
  file_path        TEXT NOT NULL,
  file_name        TEXT NOT NULL,
  mime_type        TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'running', 'failed', 'partial_failed')),
  stage            TEXT,
  progress         REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  error_code       TEXT,
  error             TEXT,
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

INSERT INTO kb_ingest_tasks (
  id, asset_id, file_path, file_name, mime_type, status, stage, progress,
  error, created_at, updated_at
)
SELECT
  id, id, file_path, file_name, mime_type, status, stage, progress,
  error, created_at, updated_at
FROM kb_ingest_tasks_legacy;

DROP TABLE kb_ingest_tasks_legacy;

CREATE UNIQUE INDEX idx_kb_ingest_asset
  ON kb_ingest_tasks(asset_id);

CREATE INDEX idx_kb_ingest_ready
  ON kb_ingest_tasks(status, next_retry_at, created_at, id);

CREATE INDEX idx_kb_ingest_lease
  ON kb_ingest_tasks(status, lease_expires_at, id);

CREATE TABLE kb_ingest_failure_shards (
  task_id        TEXT NOT NULL REFERENCES kb_ingest_tasks(id) ON DELETE CASCADE,
  stage          TEXT NOT NULL CHECK (stage IN ('parse', 'embed')),
  shard_key      TEXT NOT NULL,
  item_ids_json  TEXT NOT NULL DEFAULT '[]',
  retryable      INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
  error_code     TEXT,
  error          TEXT NOT NULL,
  attempt        INTEGER NOT NULL CHECK (attempt >= 1),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (task_id, stage, shard_key)
);

CREATE INDEX idx_kb_ingest_failures_task
  ON kb_ingest_failure_shards(task_id, stage, shard_key);

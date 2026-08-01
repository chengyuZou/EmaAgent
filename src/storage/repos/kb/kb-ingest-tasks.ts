import type { SqliteDb } from '../../database/database.js';

export type KbIngestStatus = 'pending' | 'running' | 'failed' | 'partial_failed';
export type KbIngestFailureStage = 'parse' | 'embed';

export interface KbIngestTaskRow {
  id:               string;
  asset_id:         string;
  file_path:        string;
  file_name:        string;
  mime_type:        string | null;
  status:           KbIngestStatus;
  stage:            string | null;
  progress:         number;
  error_code:       string | null;
  error:            string | null;
  attempt:          number;
  version:          number;
  lease_token:      string | null;
  lease_expires_at: number | null;
  next_retry_at:    number;
  total_items:      number;
  completed_items:  number;
  failed_items:     number;
  created_at:       number;
  updated_at:       number;
}

export interface KbIngestTask {
  id:               string;
  assetId:          string;
  filePath:         string;
  fileName:         string;
  mimeType?:        string;
  status:           KbIngestStatus;
  stage?:           string;
  progress:         number;
  errorCode?:       string;
  error?:           string;
  attempt:          number;
  version:          number;
  leaseToken?:      string;
  leaseExpiresAt?:  number;
  nextRetryAt:      number;
  totalItems:       number;
  completedItems:   number;
  failedItems:      number;
  createdAt:        number;
  updatedAt:        number;
}

export interface KbIngestFailureShardRow {
  task_id:       string;
  stage:         KbIngestFailureStage;
  shard_key:     string;
  item_ids_json: string;
  retryable:     number;
  error_code:    string | null;
  error:         string;
  attempt:       number;
  created_at:    number;
  updated_at:    number;
}

export interface KbIngestFailureShard {
  taskId:     string;
  stage:      KbIngestFailureStage;
  shardKey:   string;
  itemIds:    string[];
  retryable:  boolean;
  errorCode?: string;
  error:      string;
  attempt:    number;
  createdAt:  number;
  updatedAt:  number;
}

function rowToTask(row: KbIngestTaskRow): KbIngestTask {
  return {
    id: row.id,
    assetId: row.asset_id,
    filePath: row.file_path,
    fileName: row.file_name,
    ...(row.mime_type !== null ? { mimeType: row.mime_type } : {}),
    status: row.status,
    ...(row.stage !== null ? { stage: row.stage } : {}),
    progress: row.progress,
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    attempt: row.attempt,
    version: row.version,
    ...(row.lease_token !== null ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at !== null ? { leaseExpiresAt: row.lease_expires_at } : {}),
    nextRetryAt: row.next_retry_at,
    totalItems: row.total_items,
    completedItems: row.completed_items,
    failedItems: row.failed_items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToFailure(row: KbIngestFailureShardRow): KbIngestFailureShard {
  return {
    taskId: row.task_id,
    stage: row.stage,
    shardKey: row.shard_key,
    itemIds: JSON.parse(row.item_ids_json) as string[],
    retryable: row.retryable === 1,
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    error: row.error,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** KB 持久任务队列的原子存储操作；状态转换由 IngestQueue Facade 独占。 */
export class KbIngestTasksRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(task: {
    id: string;
    assetId: string;
    filePath: string;
    fileName: string;
    mimeType?: string;
  }): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO kb_ingest_tasks (
         id, asset_id, file_path, file_name, mime_type,
         status, progress, next_retry_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ).run(
      task.id,
      task.assetId,
      task.filePath,
      task.fileName,
      task.mimeType ?? null,
      now,
      now,
      now,
    );
  }

  claimNextPending(args: {
    leaseToken: string;
    leaseExpiresAt: number;
    now: number;
  }): KbIngestTask | undefined {
    return this.db.transaction(() => {
      // 租约到期表示原 Worker 已失去所有权。先增加 version 再重新排队，
      // 使原 Worker 的迟到 progress/terminal 更新全部 CAS 失败。
      this.db.prepare(
        `UPDATE kb_ingest_tasks
            SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
                error_code = 'kb/lease_expired', error = '导入 Worker 租约过期，任务已重新排队',
                next_retry_at = ?, version = version + 1, updated_at = ?
          WHERE status = 'running' AND lease_expires_at <= ?`,
      ).run(args.now, args.now, args.now);

      const row = this.db.prepare(
        `UPDATE kb_ingest_tasks
            SET status = 'running',
                attempt = attempt + 1,
                version = version + 1,
                lease_token = ?,
                lease_expires_at = ?,
                error_code = NULL,
                error = NULL,
                updated_at = ?
          WHERE id = (
            SELECT id FROM kb_ingest_tasks
             WHERE status = 'pending' AND next_retry_at <= ?
             ORDER BY next_retry_at ASC, created_at ASC, id ASC
             LIMIT 1
          )
            AND status = 'pending'
          RETURNING *`,
      ).get(
        args.leaseToken,
        args.leaseExpiresAt,
        args.now,
        args.now,
      ) as KbIngestTaskRow | undefined;
      return row ? rowToTask(row) : undefined;
    })();
  }

  extendLease(
    id: string,
    leaseToken: string,
    attempt: number,
    leaseExpiresAt: number,
    at: number,
  ): boolean {
    return this.db.prepare(
      `UPDATE kb_ingest_tasks
          SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
          AND lease_token = ? AND attempt = ?
          AND lease_expires_at > ?`,
    ).run(leaseExpiresAt, at, id, leaseToken, attempt, at).changes === 1;
  }

  updateProgress(
    id: string,
    attempt: number,
    stage: string,
    progress: number,
  ): boolean {
    const bounded = Math.min(1, Math.max(0, progress));
    const now = Date.now();
    return this.db.prepare(
      `UPDATE kb_ingest_tasks
          SET stage = ?, progress = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND attempt = ?
          AND lease_expires_at > ?`,
    ).run(stage, bounded, now, id, attempt, now).changes === 1;
  }

  complete(id: string, leaseToken: string, version: number): boolean {
    const now = Date.now();
    return this.db.prepare(
      `DELETE FROM kb_ingest_tasks
        WHERE id = ? AND status = 'running'
          AND lease_token = ? AND version = ?
          AND lease_expires_at > ?`,
    ).run(id, leaseToken, version, now).changes === 1;
  }

  fail(args: {
    id: string;
    leaseToken: string;
    version: number;
    errorCode: string;
    error: string;
    retryAt?: number;
  }): KbIngestTask | undefined {
    const now = Date.now();
    const row = this.db.prepare(
      `UPDATE kb_ingest_tasks
          SET status = 'failed', error_code = ?, error = ?,
              lease_token = NULL, lease_expires_at = NULL,
              next_retry_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'running'
          AND lease_token = ? AND version = ?
          AND lease_expires_at > ?
        RETURNING *`,
    ).get(
      args.errorCode,
      args.error,
      args.retryAt ?? now,
      now,
      args.id,
      args.leaseToken,
      args.version,
      now,
    ) as KbIngestTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  partialFail(args: {
    id: string;
    leaseToken: string;
    version: number;
    stage: KbIngestFailureStage;
    errorCode: string;
    error: string;
    totalItems: number;
    completedItems: number;
    failedItems: number;
    failures: Array<{
      stage: KbIngestFailureStage;
      shardKey: string;
      itemIds: string[];
      retryable: boolean;
      errorCode?: string;
      error: string;
    }>;
  }): KbIngestTask | undefined {
    return this.db.transaction(() => {
      const now = Date.now();
      const row = this.db.prepare(
        `UPDATE kb_ingest_tasks
            SET status = 'partial_failed', stage = ?, progress = 1,
                error_code = ?, error = ?, total_items = ?,
                completed_items = ?, failed_items = ?,
                lease_token = NULL, lease_expires_at = NULL,
                version = version + 1, updated_at = ?
          WHERE id = ? AND status = 'running'
            AND lease_token = ? AND version = ?
            AND lease_expires_at > ?
          RETURNING *`,
      ).get(
        args.stage,
        args.errorCode,
        args.error,
        args.totalItems,
        args.completedItems,
        args.failedItems,
        now,
        args.id,
        args.leaseToken,
        args.version,
        now,
      ) as KbIngestTaskRow | undefined;
      if (!row) return undefined;

      this.replaceFailuresInTransaction(args.id, row.attempt, args.failures, now);
      return rowToTask(row);
    })();
  }

  retry(id: string, expectedVersion: number): KbIngestTask | undefined {
    const now = Date.now();
    const row = this.db.prepare(
      `UPDATE kb_ingest_tasks
          SET status = 'pending', stage = NULL, progress = 0,
              error_code = NULL, error = NULL,
              lease_token = NULL, lease_expires_at = NULL,
              next_retry_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status IN ('failed', 'partial_failed')
          AND version = ?
        RETURNING *`,
    ).get(now, now, id, expectedVersion) as KbIngestTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  private replaceFailuresInTransaction(
    taskId: string,
    attempt: number,
    failures: Array<{
      stage: KbIngestFailureStage;
      shardKey: string;
      itemIds: string[];
      retryable: boolean;
      errorCode?: string;
      error: string;
    }>,
    now: number,
  ): void {
    this.db.prepare('DELETE FROM kb_ingest_failure_shards WHERE task_id = ?').run(taskId);
    const insert = this.db.prepare(
      `INSERT INTO kb_ingest_failure_shards (
         task_id, stage, shard_key, item_ids_json, retryable,
         error_code, error, attempt, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const failure of failures) {
      insert.run(
        taskId,
        failure.stage,
        failure.shardKey,
        JSON.stringify(failure.itemIds),
        failure.retryable ? 1 : 0,
        failure.errorCode ?? null,
        failure.error,
        attempt,
        now,
        now,
      );
    }
  }

  listFailures(taskId: string): KbIngestFailureShard[] {
    return (this.db.prepare(
      `SELECT * FROM kb_ingest_failure_shards
        WHERE task_id = ? ORDER BY stage ASC, shard_key ASC`,
    ).all(taskId) as KbIngestFailureShardRow[]).map(rowToFailure);
  }

  listActive(): KbIngestTask[] {
    return (this.db.prepare(
      `SELECT * FROM kb_ingest_tasks
        ORDER BY created_at DESC, id DESC`,
    ).all() as KbIngestTaskRow[]).map(rowToTask);
  }

  get(id: string): KbIngestTask | undefined {
    const row = this.db.prepare(
      'SELECT * FROM kb_ingest_tasks WHERE id = ?',
    ).get(id) as KbIngestTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  findByAssetId(assetId: string): KbIngestTask | undefined {
    const row = this.db.prepare(
      'SELECT * FROM kb_ingest_tasks WHERE asset_id = ?',
    ).get(assetId) as KbIngestTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /** 应用重启意味着旧 Worker 已消失；安全地重新排队，而不是保留幽灵 running。 */
  recoverInterrupted(at: number): number {
    return this.db.prepare(
      `UPDATE kb_ingest_tasks
          SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
              error_code = 'kb/process_interrupted',
              error = '应用重启中断，任务已重新排队',
              next_retry_at = ?, version = version + 1, updated_at = ?
        WHERE status = 'running'`,
    ).run(at, at).changes;
  }
}

// 知识库重建索引(re-embed)后台任务的持久存储: 每个任务一行, 状态推进全部走 租约+版本号 CAS。
// 位于 storage 仓库层(repos), 与 KbIngestTasksRepo 同型, 只被 KB 包的 ReembedQueue 调用。

import type { SqliteDb } from '../../database/database.js';

export type KbReembedStatus = 'pending' | 'running' | 'failed' | 'partial_failed' | 'cancelled';
export type KbReembedFailureStage = 'embed';

export interface KbReembedTaskRow {
  id:               string;
  asset_id:         string | null;
  ebd_provider_id:  string;
  ebd_model:        string;
  status:           KbReembedStatus;
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

export interface KbReembedTask {
  id:               string;
  /** NULL = 全库 stale 扫描; 有值 = 单文档重建。 */
  assetId?:         string;
  ebdProviderId:    string;
  ebdModel:         string;
  status:           KbReembedStatus;
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

export interface KbReembedFailureShardRow {
  task_id:       string;
  stage:         KbReembedFailureStage;
  shard_key:     string;
  item_ids_json: string;
  retryable:     number;
  error_code:    string | null;
  error:         string;
  attempt:       number;
  created_at:    number;
  updated_at:    number;
}

export interface KbReembedFailureShard {
  taskId:     string;
  stage:      KbReembedFailureStage;
  shardKey:   string;
  itemIds:    string[];
  retryable:  boolean;
  errorCode?: string;
  error:      string;
  attempt:    number;
  createdAt:  number;
  updatedAt:  number;
}

function rowToTask(row: KbReembedTaskRow): KbReembedTask {
  return {
    id: row.id,
    ...(row.asset_id !== null ? { assetId: row.asset_id } : {}),
    ebdProviderId: row.ebd_provider_id,
    ebdModel: row.ebd_model,
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

function rowToFailure(row: KbReembedFailureShardRow): KbReembedFailureShard {
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

/** KB 重建任务的持久队列原子存储操作；状态转换由 ReembedQueue Facade 独占。 */
export class KbReembedTasksRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(task: {
    id: string;
    assetId?: string;
    ebdProviderId: string;
    ebdModel: string;
  }): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO kb_reembed_tasks (
         id, asset_id, ebd_provider_id, ebd_model,
         status, progress, next_retry_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ).run(
      task.id,
      task.assetId ?? null,
      task.ebdProviderId,
      task.ebdModel,
      now,
      now,
      now,
    );
  }

  /** 当前 pending/running 的最早一条任务；用于幂等入队(已有扫描在跑就不重复建)。 */
  findActive(): KbReembedTask | undefined {
    const row = this.db.prepare(
      `SELECT * FROM kb_reembed_tasks
        WHERE status IN ('pending', 'running')
        ORDER BY created_at ASC, id ASC LIMIT 1`,
    ).get() as KbReembedTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  claimNextPending(args: {
    leaseToken: string;
    leaseExpiresAt: number;
    now: number;
  }): KbReembedTask | undefined {
    return this.db.transaction(() => {
      // 租约到期表示原 Worker 已失去所有权。先增加 version 再重新排队，
      // 使原 Worker 的迟到 progress/terminal 更新全部 CAS 失败。
      this.db.prepare(
        `UPDATE kb_reembed_tasks
            SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
                error_code = 'kb/lease_expired', error = '重建 Worker 租约过期，任务已重新排队',
                next_retry_at = ?, version = version + 1, updated_at = ?
          WHERE status = 'running' AND lease_expires_at <= ?`,
      ).run(args.now, args.now, args.now);

      const row = this.db.prepare(
        `UPDATE kb_reembed_tasks
            SET status = 'running',
                attempt = attempt + 1,
                version = version + 1,
                lease_token = ?,
                lease_expires_at = ?,
                error_code = NULL,
                error = NULL,
                updated_at = ?
          WHERE id = (
            SELECT id FROM kb_reembed_tasks
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
      ) as KbReembedTaskRow | undefined;
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
      `UPDATE kb_reembed_tasks
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
      `UPDATE kb_reembed_tasks
          SET stage = ?, progress = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND attempt = ?
          AND lease_expires_at > ?`,
    ).run(stage, bounded, now, id, attempt, now).changes === 1;
  }

  complete(id: string, leaseToken: string, version: number): boolean {
    const now = Date.now();
    return this.db.prepare(
      `DELETE FROM kb_reembed_tasks
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
  }): KbReembedTask | undefined {
    const now = Date.now();
    const row = this.db.prepare(
      `UPDATE kb_reembed_tasks
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
    ) as KbReembedTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  partialFail(args: {
    id: string;
    leaseToken: string;
    version: number;
    stage: KbReembedFailureStage;
    errorCode: string;
    error: string;
    totalItems: number;
    completedItems: number;
    failedItems: number;
    failures: Array<{
      stage: KbReembedFailureStage;
      shardKey: string;
      itemIds: string[];
      retryable: boolean;
      errorCode?: string;
      error: string;
    }>;
  }): KbReembedTask | undefined {
    return this.db.transaction(() => {
      const now = Date.now();
      const row = this.db.prepare(
        `UPDATE kb_reembed_tasks
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
      ) as KbReembedTaskRow | undefined;
      if (!row) return undefined;

      this.replaceFailuresInTransaction(args.id, row.attempt, args.failures, now);
      return rowToTask(row);
    })();
  }

  /**
   * 用户主动取消。version 自增并清租约: 运行中的 Worker 心跳续租会失败并中止,
   * 其迟到终态 CAS 也因 status/version 不匹配而无法覆盖 cancelled。
   */
  cancel(id: string): boolean {
    const now = Date.now();
    return this.db.prepare(
      `UPDATE kb_reembed_tasks
          SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
              version = version + 1, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'running')`,
    ).run(now, id).changes === 1;
  }

  retry(id: string, expectedVersion: number): KbReembedTask | undefined {
    const now = Date.now();
    const row = this.db.prepare(
      `UPDATE kb_reembed_tasks
          SET status = 'pending', stage = NULL, progress = 0,
              error_code = NULL, error = NULL,
              lease_token = NULL, lease_expires_at = NULL,
              next_retry_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status IN ('failed', 'partial_failed', 'cancelled')
          AND version = ?
        RETURNING *`,
    ).get(now, now, id, expectedVersion) as KbReembedTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  private replaceFailuresInTransaction(
    taskId: string,
    attempt: number,
    failures: Array<{
      stage: KbReembedFailureStage;
      shardKey: string;
      itemIds: string[];
      retryable: boolean;
      errorCode?: string;
      error: string;
    }>,
    now: number,
  ): void {
    this.db.prepare('DELETE FROM kb_reembed_failure_shards WHERE task_id = ?').run(taskId);
    const insert = this.db.prepare(
      `INSERT INTO kb_reembed_failure_shards (
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

  listFailures(taskId: string): KbReembedFailureShard[] {
    return (this.db.prepare(
      `SELECT * FROM kb_reembed_failure_shards
        WHERE task_id = ? ORDER BY stage ASC, shard_key ASC`,
    ).all(taskId) as KbReembedFailureShardRow[]).map(rowToFailure);
  }

  listActive(): KbReembedTask[] {
    return (this.db.prepare(
      `SELECT * FROM kb_reembed_tasks
        ORDER BY created_at DESC, id DESC`,
    ).all() as KbReembedTaskRow[]).map(rowToTask);
  }

  get(id: string): KbReembedTask | undefined {
    const row = this.db.prepare(
      'SELECT * FROM kb_reembed_tasks WHERE id = ?',
    ).get(id) as KbReembedTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /** 应用重启意味着旧 Worker 已消失；安全地重新排队，而不是保留幽灵 running。 */
  recoverInterrupted(at: number): number {
    return this.db.prepare(
      `UPDATE kb_reembed_tasks
          SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
              error_code = 'kb/process_interrupted',
              error = '应用重启中断，任务已重新排队',
              next_retry_at = ?, version = version + 1, updated_at = ?
        WHERE status = 'running'`,
    ).run(at, at).changes;
  }
}

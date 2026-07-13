import type { SqliteDb } from '../database.js';

// ── 类型 ─────────────────────────────────────────────────────────────────────

// TODO-V1.1 与 contracts 中的 BackgroundTask 合并，但目前我们需要自由度来
export type MemoryTaskKind =
  | 'extraction'
  | 'embedding_refresh'
  | 'maintenance'
  | 'consolidation';

export type MemoryTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export interface MemoryTaskRow {
  id:            string;
  kind:          MemoryTaskKind;
  status:        MemoryTaskStatus;
  session_id:    string;
  payload_json:  string;
  attempts:      number;
  last_error:    string | null;
  created_at:    number;
  updated_at:    number;
}

export interface MemoryTaskEnqueue {
  id:           string;
  kind:         MemoryTaskKind;
  sessionId:    string;
  payload:      Record<string, unknown>;
  createdAt:    number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * memory 工作的持久队列(extraction、consolidation、
 * maintenance、embedding refresh)。生命周期：
 *
 *   enqueue() -> pending
 *   claimNext() -> running（atomic UPDATE … RETURNING）
 *   markCompleted() / markFailed() -> completed / failed
 *
 * 运行期间通过心跳租约识别失联 Worker；进程重启时，只有持有 Data Directory
 * 独占锁的新进程才能立即恢复遗留的 running 任务。attempts 同时充当执行代次，
 * 防止已经失去所有权的旧 Worker 覆盖新一轮执行结果。
 */
export class MemoryTasksRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── 入队 ─────────────────────────────────────────────────────────────────

  enqueue(t: MemoryTaskEnqueue): void {
    this.db
      .prepare(
        `INSERT INTO memory_tasks
           (id, kind, status, session_id, payload_json, attempts, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, 0, ?, ?)`,
      )
      .run(t.id, t.kind, t.sessionId, JSON.stringify(t.payload), t.createdAt, t.createdAt);
  }

  // ── 认领 ───────────────────────────────────────────────────────────────────

  /**
   * 原子地取最老的 pending 任务并标记为 running。
   * 返回认领的行，无可用工作时返回 undefined。
   * 当 worker 只处理一种 task kind 时按 kind 过滤。
   */
  claimNext(now: number, kind?: MemoryTaskKind): MemoryTaskRow | undefined {
    const whereKind = kind ? 'AND kind = ?' : '';
    // 无 kind 时 SQL 恰好 1 个 `?`（updated_at），有 kind 时 2 个。
    const params: Array<string | number> = kind ? [now, kind] : [now];
    const row = this.db
      .prepare(
        `UPDATE memory_tasks
            SET status     = 'running',
                attempts   = attempts + 1,
                updated_at = ?
          WHERE id = (
            SELECT id FROM memory_tasks
             WHERE status = 'pending' ${whereKind}
             ORDER BY created_at ASC, id ASC
             LIMIT 1
          )
          RETURNING *`,
      )
      .get(...params) as MemoryTaskRow | undefined;
    return row;
  }

  // ── 收尾 ─────────────────────────────────────────────────────────────

  markCompleted(
    id: string,
    expectedAttempt: number,
    at: number,
  ): MemoryTaskRow | undefined {
    return this.db
      .prepare(
        `UPDATE memory_tasks
            SET status = 'completed', updated_at = ?
          WHERE id = ?
            AND status = 'running'
            AND attempts = ?
          RETURNING *`,
      )
      .get(at, id, expectedAttempt) as MemoryTaskRow | undefined;
  }

  /**
   * 标记本次尝试失败。若 attempts 已超过 `maxAttempts`，
   * 任务留在 'failed'；否则回到 'pending' 等其他 worker 后续认领。
   */
  markFailed(
    id: string,
    expectedAttempt: number,
    error: string,
    at: number,
    maxAttempts = 3,
  ): MemoryTaskRow | undefined {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
      throw new RangeError('maxAttempts must be a positive integer');
    }
    return this.db
      .prepare(
        `UPDATE memory_tasks
            SET status     = CASE
                               WHEN attempts >= ? THEN 'failed'
                               ELSE 'pending'
                             END,
                last_error = ?,
                updated_at = ?
          WHERE id = ?
            AND status = 'running'
            AND attempts = ?
          RETURNING *`,
      )
      .get(maxAttempts, error, at, id, expectedAttempt) as MemoryTaskRow | undefined;
  }

  /** 仅当前执行代次可以续租；返回 false 表示任务所有权已经丢失。 */
  heartbeat(id: string, expectedAttempt: number, at: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE memory_tasks
            SET updated_at = ?
          WHERE id = ?
            AND status = 'running'
            AND attempts = ?`,
      )
      .run(at, id, expectedAttempt);
    return info.changes === 1;
  }

  // ── 读取 ────────────────────────────────────────────────────────────────────

  findById(id: string): MemoryTaskRow | undefined {
    return this.db
      .prepare('SELECT * FROM memory_tasks WHERE id = ?')
      .get(id) as MemoryTaskRow | undefined;
  }

  listByStatus(status: MemoryTaskStatus, limit = 100): MemoryTaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_tasks
          WHERE status = ?
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      .all(status, limit) as MemoryTaskRow[];
  }

  listForSession(sessionId: string, limit = 100): MemoryTaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_tasks
          WHERE session_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(sessionId, limit) as MemoryTaskRow[];
  }

  countByStatus(status: MemoryTaskStatus): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM memory_tasks WHERE status = ?')
      .get(status) as { n: number };
    return row.n;
  }

  countAllByStatus(): Record<MemoryTaskStatus, number> {
    const out: Record<MemoryTaskStatus, number> = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
    };
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM memory_tasks GROUP BY status')
      .all() as Array<{ status: MemoryTaskStatus; n: number }>;
    for (const row of rows) out[row.status] = row.n;
    return out;
  }

  // ── 启动恢复 ────────────────────────────────────────────────────────

  /**
   * 仅在获得 Data Directory 独占锁后的启动恢复阶段调用。
   * 此时所有 running 都属于已经退出的旧进程，可以立即重新入队。
   */
  recoverRunningAfterExclusiveStartup(now: number): number {
    const info = this.db
      .prepare(
        `UPDATE memory_tasks
            SET status     = 'pending',
                updated_at = ?
          WHERE status = 'running'`,
      )
      .run(now);
    return info.changes;
  }

  /** 运行期只回收超过心跳租约的任务。 */
  requeueExpiredRunning(staleBefore: number, now: number): number {
    const info = this.db
      .prepare(
        `UPDATE memory_tasks
            SET status = 'pending', updated_at = ?
          WHERE status = 'running'
            AND updated_at <= ?`,
      )
      .run(now, staleBefore);
    return info.changes;
  }

  /** completed 和 failed 都是可清理终态；单次删除有界，避免长写锁。 */
  deleteTerminal(olderThan: number, limit = 500): number {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new RangeError('limit must be an integer between 1 and 1000');
    }
    const info = this.db
      .prepare(
        `DELETE FROM memory_tasks
          WHERE id IN (
            SELECT id FROM memory_tasks
             WHERE status IN ('completed', 'failed')
               AND updated_at < ?
             ORDER BY updated_at ASC, id ASC
             LIMIT ?
          )`,
      )
      .run(olderThan, limit);
    return info.changes;
  }
}

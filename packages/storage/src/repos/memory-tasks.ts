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
 * 进程崩溃恢复靠 `resetStuckRunning()`-进程死亡时处于 running
 * 的任务被重置为 pending 以便重试。
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
             ORDER BY created_at ASC
             LIMIT 1
          )
          RETURNING *`,
      )
      .get(...params) as MemoryTaskRow | undefined;
    return row;
  }

  // ── 收尾 ─────────────────────────────────────────────────────────────

  markCompleted(id: string, at: number): void {
    this.db
      .prepare(`UPDATE memory_tasks SET status = 'completed', updated_at = ? WHERE id = ?`)
      .run(at, id);
  }

  /**
   * 标记本次尝试失败。若 attempts 已超过 `maxAttempts`，
   * 任务留在 'failed'；否则回到 'pending' 等其他 worker 后续认领。
   */
  markFailed(id: string, error: string, at: number, maxAttempts = 3): void {
    const row = this.db
      .prepare('SELECT attempts FROM memory_tasks WHERE id = ?')
      .get(id) as { attempts: number } | undefined;
    if (!row) return;

    const nextStatus: MemoryTaskStatus =
      row.attempts >= maxAttempts ? 'failed' : 'pending';
    this.db
      .prepare(
        `UPDATE memory_tasks
            SET status     = ?,
                last_error = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(nextStatus, error, at, id);
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
        'SELECT * FROM memory_tasks WHERE status = ? ORDER BY created_at ASC LIMIT ?',
      )
      .all(status, limit) as MemoryTaskRow[];
  }

  listForSession(sessionId: string, limit = 100): MemoryTaskRow[] {
    return this.db
      .prepare(
        'SELECT * FROM memory_tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
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
   * 启动时状态为 'running' 的任务是被崩溃遗留的-
   * 重置为 'pending' 使 worker 重新认领。返回迁移的数量。
   */
  resetStuckRunning(now: number): number {
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

  /** 定期 / 按需清理。 */
  deleteCompleted(olderThan: number): number {
    const info = this.db
      .prepare(`DELETE FROM memory_tasks WHERE status = 'completed' AND updated_at < ?`)
      .run(olderThan);
    return info.changes;
  }
}
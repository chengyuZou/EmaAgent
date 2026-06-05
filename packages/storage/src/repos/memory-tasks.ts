import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

// TODO - V1.1 consolidate with BackgroundTask in contracts, but for now we want the freedom to
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
 * Durable queue for fire-and-forget memory work (extraction, consolidation,
 * compaction, embedding refresh). The lifecycle is:
 *
 *   enqueue() → pending
 *   claimNext() → running (atomic UPDATE … RETURNING)
 *   markCompleted() / markFailed() → completed / failed
 *
 * Process crash recovery is `resetStuckRunning()` — any task that was running
 * when the process died is reset to pending so it'll be retried.
 */
export class MemoryTasksRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── Enqueue ─────────────────────────────────────────────────────────────────

  enqueue(t: MemoryTaskEnqueue): void {
    this.db
      .prepare(
        `INSERT INTO memory_tasks
           (id, kind, status, session_id, payload_json, attempts, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, 0, ?, ?)`,
      )
      .run(t.id, t.kind, t.sessionId, JSON.stringify(t.payload), t.createdAt, t.createdAt);
  }

  // ── Claim ───────────────────────────────────────────────────────────────────

  /**
   * Atomically pick the oldest pending task and mark it running.
   * Returns the claimed row, or undefined if no work is available.
   * Filter by kind when a worker handles only one task kind.
   */
  claimNext(now: number, kind?: MemoryTaskKind): MemoryTaskRow | undefined {
    const whereKind = kind ? 'AND kind = ?' : '';
    // SQL has exactly 1 `?` (updated_at) when no kind, 2 when kind is provided.
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

  // ── Settlements ─────────────────────────────────────────────────────────────

  markCompleted(id: string, at: number): void {
    this.db
      .prepare(`UPDATE memory_tasks SET status = 'completed', updated_at = ? WHERE id = ?`)
      .run(at, id);
  }

  /**
   * Mark this attempt failed. If attempts already exceeded `maxAttempts`,
   * the task is left in 'failed'; otherwise it goes back to 'pending' for
   * another worker to claim later.
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

  // ── Read ────────────────────────────────────────────────────────────────────

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

  // ── Startup recovery ────────────────────────────────────────────────────────

  /**
   * Any task whose status is 'running' at startup was orphaned by a crash —
   * reset to 'pending' so the worker re-picks it up. Returns the count moved.
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

  /** Periodic / on-demand cleanup. */
  deleteCompleted(olderThan: number): number {
    const info = this.db
      .prepare(`DELETE FROM memory_tasks WHERE status = 'completed' AND updated_at < ?`)
      .run(olderThan);
    return info.changes;
  }
}

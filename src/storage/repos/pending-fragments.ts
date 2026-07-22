import type { SqliteDb } from '../database.js';
import type { SessionId, TurnId } from '@ema-agent/ids';

// ── 类型─────────────────────────────────────────────────────────────────────

export interface PendingFragmentRow {
  id:         string;
  session_id: string;
  turn_id:    string;
  role:       'user' | 'assistant';
  content:    string;
  /** unix 毫秒时间戳 — 对话该侧的时间点 */
  at:         number;
  created_at: number;
}

export interface PendingFragmentInsert {
  id:        string;
  sessionId: SessionId;
  turnId:    TurnId;
  role:      'user' | 'assistant';
  content:   string;
  at:        number;
  createdAt: number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * 存储等待提取 LLM pipeline 处理的
 * 原始对话文本（user + assistant turn）。
 *
 * 生命周期：
 *   appendPending() → onTurnEnd — 每个对话侧添加一行
 *   listBySession() → pipeline 在提取前读取所有待处理行
 *   clearBySession() → pipeline 在 clearPending() 成功后删除这些行
 *
 * FK ON DELETE CASCADE 确保：
 *   - session 删除 → 其所有 fragment 自动删除
 *   - turn 删除   → 该 turn 的 fragment 自动删除
 */
export class PendingFragmentsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── 写入───────────────────────────────────────────────────────────────────

  insert(f: PendingFragmentInsert): void {
    this.db
      .prepare(
        `INSERT INTO pending_fragments
           (id, session_id, turn_id, role, content, at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(f.id, f.sessionId, f.turnId, f.role, f.content, f.at, f.createdAt);
  }

  /** 删除某 session 的所有 fragment。在提取成功后调用。 */
  clearBySession(sessionId: SessionId): void {
    this.db
      .prepare('DELETE FROM pending_fragments WHERE session_id = ?')
      .run(sessionId);
  }

  // ── 读取────────────────────────────────────────────────────────────────────

  /** 某 session 的所有未处理 fragment，按业务时间和稳定次序正序排列。 */
  listBySession(sessionId: SessionId): PendingFragmentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM pending_fragments
          WHERE session_id = ?
          ORDER BY at ASC, created_at ASC, id ASC`,
      )
      .all(sessionId) as PendingFragmentRow[];
  }

  /** 至少有一个 pending fragment 的 session。用于恢复和统计。 */
  listSessionsWithPending(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT session_id FROM pending_fragments')
      .all() as Array<{ session_id: string }>;
    return rows.map(r => r.session_id);
  }

  countSessionsWithPending(): number {
    const row = this.db
      .prepare('SELECT COUNT(DISTINCT session_id) AS n FROM pending_fragments')
      .get() as { n: number };
    return row.n;
  }

  countBySession(sessionId: SessionId): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM pending_fragments WHERE session_id = ?')
      .get(sessionId) as { n: number };
    return row.n;
  }
}

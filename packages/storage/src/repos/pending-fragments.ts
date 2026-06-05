import type { SqliteDb } from '../database.js';
import type { SessionId, TurnId } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingFragmentRow {
  id:         string;
  session_id: string;
  turn_id:    string;
  role:       'user' | 'assistant';
  content:    string;
  /** unix ms — timestamp of this side of the conversation turn */
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
 * Stores raw conversation text (user + assistant turns) waiting to be
 * processed by the extraction LLM pipeline.
 *
 * Lifecycle:
 *   appendPending() → onTurnEnd — adds a row per conversation side
 *   listBySession() → pipeline reads all pending rows before extraction
 *   clearBySession() → pipeline deletes them after successful clearPending()
 *
 * FK ON DELETE CASCADE ensures:
 *   - session deleted → all its fragments auto-deleted
 *   - turn deleted   → that turn's fragments auto-deleted
 */
export class PendingFragmentsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── Write ───────────────────────────────────────────────────────────────────

  insert(f: PendingFragmentInsert): void {
    this.db
      .prepare(
        `INSERT INTO pending_fragments
           (id, session_id, turn_id, role, content, at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(f.id, f.sessionId, f.turnId, f.role, f.content, f.at, f.createdAt);
  }

  /** Delete all fragments for a session. Called after extraction succeeds. */
  clearBySession(sessionId: SessionId): void {
    this.db
      .prepare('DELETE FROM pending_fragments WHERE session_id = ?')
      .run(sessionId);
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /** All unprocessed fragments for a session, oldest-first. */
  listBySession(sessionId: SessionId): PendingFragmentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM pending_fragments
          WHERE session_id = ?
          ORDER BY created_at ASC`,
      )
      .all(sessionId) as PendingFragmentRow[];
  }

  /** Sessions that have at least one pending fragment. Used by recovery + stats. */
  listSessionsWithPending(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT session_id FROM pending_fragments')
      .all() as Array<{ session_id: string }>;
    return rows.map(r => r.session_id);
  }

  countBySession(sessionId: SessionId): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM pending_fragments WHERE session_id = ?')
      .get(sessionId) as { n: number };
    return row.n;
  }
}

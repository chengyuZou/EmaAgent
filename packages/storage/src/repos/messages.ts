import type { SqliteDb } from '../database.js';
import type { MessageId, SessionId, TurnId, BranchId, MessageRole, MessageKind } from '@ema-agent/contracts';

export interface MessageRow {
  id:          string;
  session_id:  string;
  turn_id:     string | null;
  role:        MessageRole;
  kind:        MessageKind;
  /** JSON-encoded MessageBlocks — string literal, AssistantBlock[], or UserBlock[]. */
  blocks_json: string;
  interrupted: number;
  created_at:  number;
  meta_json:   string;
}

export interface MessageInsert {
  id:         MessageId;
  sessionId:  SessionId;
  turnId?:    TurnId;
  role:       MessageRole;
  kind?:      MessageKind;
  /** Pre-serialized JSON string (call JSON.stringify(blocks) before passing). */
  blocksJson: string;
  interrupted?: boolean;
  createdAt:  number;
  metaJson?:  string;
}

export class MessagesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(m: MessageInsert): void {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.sessionId,
        m.turnId ?? null,
        m.role,
        m.kind ?? 'normal',
        m.blocksJson,
        m.interrupted ? 1 : 0,
        m.createdAt,
        m.metaJson ?? '{}',
      );
  }

  findById(id: MessageId): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  listForSession(sessionId: SessionId, limit = 500): MessageRow[] {
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(sessionId, limit) as MessageRow[];
  }

  listForTurn(turnId: TurnId): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE turn_id = ? ORDER BY created_at ASC')
      .all(turnId) as MessageRow[];
  }

  markInterrupted(id: MessageId): void {
    this.db.prepare('UPDATE messages SET interrupted = 1 WHERE id = ?').run(id);
  }

  deleteForTurn(turnId: TurnId): void {
    this.db.prepare('DELETE FROM messages WHERE turn_id = ?').run(turnId);
  }

  /** Cursor pagination: rows with created_at < before, newest-first. */
  listBefore(sessionId: SessionId, before: number, limit: number): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND created_at < ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sessionId, before, limit) as MessageRow[];
  }

  countForSession(sessionId: SessionId): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as n FROM messages WHERE session_id = ?')
      .get(sessionId) as { n: number };
    return row.n;
  }

  // ── Branch-segment queries ────────────────────────────────────────────────

  /**
   * Root branch segment: all messages in the session whose turn belongs to
   * rootBranchId, plus messages with no turn_id (system/context rows that
   * pre-date branching). Optionally capped at turns started at or before
   * `beforeTurnStartedAt` (set to the fork point's started_at when this
   * branch has a child).
   */
  listForRootSegment(
    sessionId:           SessionId,
    rootBranchId:        BranchId,
    beforeTurnStartedAt?: number,
  ): MessageRow[] {
    return this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.session_id = ?
           AND (
             m.turn_id IS NULL
             OR m.turn_id IN (
               SELECT t.id FROM turns t
               WHERE t.branch_id = ?
                 AND (? IS NULL OR t.started_at <= ?)
             )
           )
         ORDER BY m.created_at ASC`,
      )
      .all(
        sessionId,
        rootBranchId,
        beforeTurnStartedAt ?? null,
        beforeTurnStartedAt ?? null,
      ) as MessageRow[];
  }

  /**
   * Non-root branch segment: only messages whose turn has branch_id = branchId,
   * optionally capped at the fork point. Does NOT include turnless messages
   * (those are already in the root segment).
   */
  listForChildSegment(branchId: BranchId, beforeTurnStartedAt?: number): MessageRow[] {
    return this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.turn_id IN (
           SELECT t.id FROM turns t
           WHERE t.branch_id = ?
             AND (? IS NULL OR t.started_at <= ?)
         )
         ORDER BY m.created_at ASC`,
      )
      .all(
        branchId,
        beforeTurnStartedAt ?? null,
        beforeTurnStartedAt ?? null,
      ) as MessageRow[];
  }

  // ── Summary / compaction boundary helpers ──────────────────────────────────

  /** Most recent message with kind='summary' for this session, if any. */
  findLastSummary(sessionId: SessionId): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM messages
          WHERE session_id = ? AND kind = 'summary'
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(sessionId) as MessageRow | undefined;
  }

  /**
   * Returns all messages from the last `summary` row onward (inclusive of the
   * summary itself), capped at `limit`. When no summary exists this is
   * equivalent to listForSession(). Used by the LLM-facing history loader so
   * engines automatically see only post-compaction history.
   */
  listForSessionFromSummary(sessionId: SessionId, limit = 500): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
          WHERE session_id = ?
            AND created_at >= COALESCE((
              SELECT MAX(created_at) FROM messages
               WHERE session_id = ? AND kind = 'summary'
            ), 0)
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(sessionId, sessionId, limit) as MessageRow[];
  }
}

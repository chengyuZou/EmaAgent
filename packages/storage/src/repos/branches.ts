import type { SqliteDb } from '../database.js';
import type { BranchId, SessionId, TurnId } from '@ema-agent/contracts';

export interface BranchRow {
  id:                string;
  session_id:        string;
  parent_branch_id:  string | null;
  fork_from_turn_id: string | null;
  created_at:        number;
}

export interface BranchInsert {
  id:              BranchId;
  sessionId:       SessionId;
  parentBranchId?: BranchId;
  forkFromTurnId?: TurnId;
  createdAt:       number;
}

export class BranchesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(b: BranchInsert): void {
    this.db
      .prepare(
        `INSERT INTO branches (id, session_id, parent_branch_id, fork_from_turn_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(b.id, b.sessionId, b.parentBranchId ?? null, b.forkFromTurnId ?? null, b.createdAt);
  }

  findById(id: BranchId): BranchRow | undefined {
    return this.db
      .prepare('SELECT * FROM branches WHERE id = ?')
      .get(id) as BranchRow | undefined;
  }

  /** Root branch for a session (parent_branch_id IS NULL). */
  findRoot(sessionId: SessionId): BranchRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM branches WHERE session_id = ? AND parent_branch_id IS NULL LIMIT 1',
      )
      .get(sessionId) as BranchRow | undefined;
  }

  listForSession(sessionId: SessionId): BranchRow[] {
    return this.db
      .prepare('SELECT * FROM branches WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as BranchRow[];
  }

  /**
   * All branches that forked from the same turn — used to render the < N/M >
   * sibling navigator in the chat UI. Does NOT include the parent branch itself
   * (the caller adds it at position 0 when building the sibling list).
   */
  listSiblingsAt(forkFromTurnId: TurnId): BranchRow[] {
    return this.db
      .prepare(
        'SELECT * FROM branches WHERE fork_from_turn_id = ? ORDER BY created_at ASC',
      )
      .all(forkFromTurnId) as BranchRow[];
  }
}

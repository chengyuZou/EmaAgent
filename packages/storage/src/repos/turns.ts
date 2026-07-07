import type { SqliteDb } from '../database.js';
import type { TurnId, SessionId, TurnMode, TurnStatus, BranchId } from '@ema-agent/contracts';

export interface TurnRow {
  id: string;
  session_id: string;
  mode: TurnMode;
  status: TurnStatus;
  user_input: string;
  started_at: number;
  completed_at: number | null;
  error_code: string | null;
  error_message: string | null;
  iterations: number;
  usage_input_tokens: number;
  usage_output_tokens: number;
  branch_id: string | null;
  meta_json: string;
}

export interface TurnInsert {
  id: TurnId;
  sessionId: SessionId;
  mode: TurnMode;
  branchId?: BranchId;
  userInput: string;
  startedAt: number;
}

export interface TurnCompletion {
  status: TurnStatus;
  completedAt: number;
  errorCode?: string;
  errorMessage?: string;
  iterations?: number;
  usageInputTokens?: number;
  usageOutputTokens?: number;
}

export class TurnsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(t: TurnInsert): void {
    this.db
      .prepare(
        `INSERT INTO turns
           (id, session_id, mode, branch_id, status, user_input, started_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(t.id, t.sessionId, t.mode, t.branchId ?? null, t.userInput, t.startedAt);
  }

  /**
   * Copy a completed turn row to a new session with a fresh id. Used by fork
   * (both forkInto and the branch-aware path) so the forked session retains
   * mode / status / usage / timing. branch_id is always cleared — the new
   * session starts flat (no branches).
   */
  copyTurn(src: TurnRow, newSessionId: SessionId, newId: TurnId): void {
    this.db
      .prepare(
        `INSERT INTO turns
           (id, session_id, mode, branch_id, status, user_input, started_at, completed_at,
            error_code, error_message, iterations, usage_input_tokens, usage_output_tokens, meta_json)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId, newSessionId, src.mode, src.status, src.user_input, src.started_at, src.completed_at,
        src.error_code, src.error_message, src.iterations, src.usage_input_tokens,
        src.usage_output_tokens, src.meta_json ?? '{}',
      );
  }

  setRunning(id: TurnId): void {
    this.db
      .prepare("UPDATE turns SET status = 'running' WHERE id = ?")
      .run(id);
  }

  complete(id: TurnId, c: TurnCompletion): void {
    this.db
      .prepare(
        `UPDATE turns SET
           status = ?, completed_at = ?, error_code = ?, error_message = ?,
           iterations = ?, usage_input_tokens = ?, usage_output_tokens = ?
         WHERE id = ?`,
      )
      .run(
        c.status,
        c.completedAt,
        c.errorCode ?? null,
        c.errorMessage ?? null,
        c.iterations ?? 0,
        c.usageInputTokens ?? 0,
        c.usageOutputTokens ?? 0,
        id,
      );
  }

  findById(id: TurnId): TurnRow | undefined {
    return this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as TurnRow | undefined;
  }

  listForSession(sessionId: SessionId, limit = 100): TurnRow[] {
    return this.db
      .prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(sessionId, limit) as TurnRow[];
  }

  findRunning(sessionId: SessionId): TurnRow | undefined {
    return this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? AND status = 'running' LIMIT 1")
      .get(sessionId) as TurnRow | undefined;
  }

  abortStale(sessionId: SessionId, now: number): void {
    this.db
      .prepare(
        `UPDATE turns SET status = 'aborted', completed_at = ?
         WHERE session_id = ? AND status IN ('pending','running')`,
      )
      .run(now, sessionId);
  }

  /** Process-crash recovery: mark every still-running turn across ALL sessions as aborted. */
  abortAllStale(now: number): number {
    const result = this.db
      .prepare(
        `UPDATE turns SET status = 'aborted', completed_at = ?
         WHERE status IN ('pending','running')`,
      )
      .run(now);
    return result.changes;
  }

  /**
   * Turns on a specific branch, optionally capped at a started_at cutoff.
   * Used when reconstructing the linear message history for a forked branch:
   * each ancestor branch only contributes turns up to its fork point.
   */
  listForBranch(branchId: BranchId, beforeStartedAt?: number): TurnRow[] {
    if (beforeStartedAt === undefined) {
      return this.db
        .prepare('SELECT * FROM turns WHERE branch_id = ? ORDER BY started_at ASC')
        .all(branchId) as TurnRow[];
    }
    return this.db
      .prepare(
        'SELECT * FROM turns WHERE branch_id = ? AND started_at <= ? ORDER BY started_at ASC',
      )
      .all(branchId, beforeStartedAt) as TurnRow[];
  }

  /**
   * Backfill all pre-fork turns (branch_id IS NULL) to the given branch.
   * Called once when the first fork occurs in a session so the root branch
   * owns all existing turns. Returns the number of rows updated.
   */
  assignBranch(sessionId: SessionId, branchId: BranchId): number {
    const result = this.db
      .prepare(
        'UPDATE turns SET branch_id = ? WHERE session_id = ? AND branch_id IS NULL',
      )
      .run(branchId, sessionId);
    return result.changes;
  }
}

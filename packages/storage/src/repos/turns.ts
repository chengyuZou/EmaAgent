import type { SqliteDb } from '../database.js';
import type { TurnId, SessionId, TurnMode, AgentSubMode, TurnStatus } from '@ema-agent/contracts';

export interface TurnRow {
  id: string;
  session_id: string;
  mode: TurnMode;
  agent_sub_mode: AgentSubMode | null;
  status: TurnStatus;
  user_input: string;
  started_at: number;
  completed_at: number | null;
  error_code: string | null;
  error_message: string | null;
  iterations: number;
  usage_input_tokens: number;
  usage_output_tokens: number;
  cost_usd: number;
  meta_json: string;
}

export interface TurnInsert {
  id: TurnId;
  sessionId: SessionId;
  mode: TurnMode;
  agentSubMode?: AgentSubMode;
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
  costUsd?: number;
}

export class TurnsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(t: TurnInsert): void {
    this.db
      .prepare(
        `INSERT INTO turns
           (id, session_id, mode, agent_sub_mode, status, user_input, started_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(t.id, t.sessionId, t.mode, t.agentSubMode ?? null, t.userInput, t.startedAt);
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
           iterations = ?, usage_input_tokens = ?, usage_output_tokens = ?, cost_usd = ?
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
        c.costUsd ?? 0,
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
}

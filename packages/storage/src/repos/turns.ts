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
   * 把一个已完成 turn 行复制到新 session(新 id)。用于 fork
   * (forkInto 和 branch 感知路径都用到),使 fork 出的 session 保留
   * mode / status / usage / 时序。branch_id 总是清空--新 session 起始
   * 扁平(无 branch)。
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

  /** 进程崩溃恢复:把所有 session 中仍在运行的 turn 标记为 aborted。 */
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
   * 某个 branch 上的 turn,可选 started_at 截断点。
   * 用于重建 fork branch 的线性消息历史:
   * 每个祖先 branch 只贡献到其 fork 点为止的 turn。
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
   * 把所有 fork 前的 turn(branch_id IS NULL)回填到给定 branch。
   * 在 session 中首次 fork 时调用一次,使 root branch 拥有所有既有 turn。
   * 返回更新的行数。
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

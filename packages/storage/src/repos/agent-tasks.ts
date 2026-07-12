import type { SqliteDb } from '../database.js';
import type { AskUserQuestionSpec } from '@ema-agent/contracts';

// ── 类型─────────────────────────────────────────────────────────────────────

export type AgentTaskStatus =
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentTaskRow {
  id:                     string;
  session_id:             string;
  turn_id:                string | null;
  parent_id:              string | null;
  status:                 AgentTaskStatus;
  pending_prompt_id:      string | null;
  pending_questions_json: string | null;
  error:                  string | null;
  iterations:             number | null;
  input_tokens:           number | null;
  output_tokens:          number | null;
  created_at:             number;
  updated_at:             number;
}

export interface AgentTaskInsert {
  id:        string;
  sessionId: string;
  turnId:    string | null;
  parentId:  string | null;
  createdAt: number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

export class AgentTasksRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── 写入────────────────────────────────────────────────────────────────────

  /** 幂等：INSERT OR IGNORE，重复 claim() 调用无副作用。 */
  insert(t: AgentTaskInsert): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_tasks
           (id, session_id, turn_id, parent_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(t.id, t.sessionId, t.turnId, t.parentId, t.createdAt, t.createdAt);
  }

  waitUser(id: string, promptId: string, questions: AskUserQuestionSpec[], at: number): void {
    this.db
      .prepare(
        `UPDATE agent_tasks
            SET status                 = 'waiting_user',
                pending_prompt_id      = ?,
                pending_questions_json = ?,
                updated_at             = ?
          WHERE id = ?`,
      )
      .run(promptId, JSON.stringify(questions), at, id);
  }

  userAnswered(id: string, at: number): void {
    this.db
      .prepare(
        `UPDATE agent_tasks
            SET status                 = 'running',
                pending_prompt_id      = NULL,
                pending_questions_json = NULL,
                updated_at             = ?
          WHERE id = ?`,
      )
      .run(at, id);
  }

  complete(
    id:    string,
    stats: { iterations: number; inputTokens: number; outputTokens: number },
    at:    number,
  ): void {
    this.db
      .prepare(
        `UPDATE agent_tasks
            SET status        = 'completed',
                iterations    = ?,
                input_tokens  = ?,
                output_tokens = ?,
                updated_at    = ?
          WHERE id = ?`,
      )
      .run(stats.iterations, stats.inputTokens, stats.outputTokens, at, id);
  }

  fail(id: string, error: string, at: number): void {
    this.db
      .prepare(
        `UPDATE agent_tasks
            SET status = 'failed', error = ?,
                pending_prompt_id = NULL, pending_questions_json = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(error, at, id);
  }

  cancel(id: string, reason: string, at: number): void {
    this.db
      .prepare(
        `UPDATE agent_tasks
            SET status = 'cancelled', error = ?,
                pending_prompt_id = NULL, pending_questions_json = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(reason, at, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM agent_tasks WHERE id = ?').run(id);
  }

  /** 批量删除某 session 的终态 task。返回删除数量。 */
  deleteTerminalForSession(sessionId: string): number {
    const info = this.db
      .prepare(
        `DELETE FROM agent_tasks
          WHERE session_id = ? AND status IN ('completed','failed','cancelled')`,
      )
      .run(sessionId);
    return info.changes;
  }

  // ── 读取─────────────────────────────────────────────────────────────────────

  findById(id: string): AgentTaskRow | undefined {
    return this.db
      .prepare('SELECT * FROM agent_tasks WHERE id = ?')
      .get(id) as AgentTaskRow | undefined;
  }

  listForSession(sessionId: string, limit = 200): AgentTaskRow[] {
    return this.db
      .prepare(
        'SELECT * FROM agent_tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(sessionId, limit) as AgentTaskRow[];
  }

  listRunning(): AgentTaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_tasks
          WHERE status IN ('running','waiting_user')
          ORDER BY created_at ASC`,
      )
      .all() as AgentTaskRow[];
  }

  /**
   * 崩溃恢复：将所有仍处于非终态的 task 标记为 failed。
   * 返回被修改的行（用于启动日志）。
   */
  markStuckFailed(at: number): AgentTaskRow[] {
    return this.db
      .prepare(
        `UPDATE agent_tasks
            SET status     = 'failed',
                error      = 'Process terminated unexpectedly',
                updated_at = ?
          WHERE status IN ('running','waiting_user')
          RETURNING *`,
      )
      .all(at) as AgentTaskRow[];
  }
}

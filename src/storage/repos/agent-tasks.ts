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
  version:                number;
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

  waitUser(
    id: string,
    expectedVersion: number,
    promptId: string,
    questions: AskUserQuestionSpec[],
    at: number,
  ): AgentTaskRow | undefined {
    return this.db
      .prepare(
        `UPDATE agent_tasks
            SET status                 = 'waiting_user',
                pending_prompt_id      = ?,
                pending_questions_json = ?,
                version                = version + 1,
                updated_at             = ?
          WHERE id = ?
            AND status = 'running'
            AND version = ?
          RETURNING *`,
      )
      .get(promptId, JSON.stringify(questions), at, id, expectedVersion) as AgentTaskRow | undefined;
  }

  userAnswered(
    id: string,
    expectedVersion: number,
    promptId: string,
    at: number,
  ): AgentTaskRow | undefined {
    return this.db
      .prepare(
        `UPDATE agent_tasks
            SET status                 = 'running',
                pending_prompt_id      = NULL,
                pending_questions_json = NULL,
                version                = version + 1,
                updated_at             = ?
          WHERE id = ?
            AND status = 'waiting_user'
            AND pending_prompt_id = ?
            AND version = ?
          RETURNING *`,
      )
      .get(at, id, promptId, expectedVersion) as AgentTaskRow | undefined;
  }

  complete(
    id:    string,
    expectedVersion: number,
    stats: { iterations: number; inputTokens: number; outputTokens: number },
    at:    number,
  ): AgentTaskRow | undefined {
    return this.db
      .prepare(
        `UPDATE agent_tasks
            SET status        = 'completed',
                iterations    = ?,
                input_tokens  = ?,
                output_tokens = ?,
                error         = NULL,
                version       = version + 1,
                updated_at    = ?
          WHERE id = ?
            AND status = 'running'
            AND version = ?
          RETURNING *`,
      )
      .get(
        stats.iterations,
        stats.inputTokens,
        stats.outputTokens,
        at,
        id,
        expectedVersion,
      ) as AgentTaskRow | undefined;
  }

  fail(id: string, expectedVersion: number, error: string, at: number): AgentTaskRow | undefined {
    return this.db
      .prepare(
        `UPDATE agent_tasks
            SET status = 'failed', error = ?,
                pending_prompt_id = NULL, pending_questions_json = NULL,
                version = version + 1,
                updated_at = ?
          WHERE id = ?
            AND status IN ('running', 'waiting_user')
            AND version = ?
          RETURNING *`,
      )
      .get(error, at, id, expectedVersion) as AgentTaskRow | undefined;
  }

  cancel(id: string, expectedVersion: number, reason: string, at: number): AgentTaskRow | undefined {
    return this.db
      .prepare(
        `UPDATE agent_tasks
            SET status = 'cancelled', error = ?,
                pending_prompt_id = NULL, pending_questions_json = NULL,
                version = version + 1,
                updated_at = ?
          WHERE id = ?
            AND status IN ('running', 'waiting_user')
            AND version = ?
          RETURNING *`,
      )
      .get(reason, at, id, expectedVersion) as AgentTaskRow | undefined;
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
        'SELECT * FROM agent_tasks WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
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
                pending_prompt_id = NULL,
                pending_questions_json = NULL,
                version    = version + 1,
                updated_at = ?
          WHERE status IN ('running','waiting_user')
          RETURNING *`,
      )
      .all(at) as AgentTaskRow[];
  }
}

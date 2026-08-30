// AgentRun 数据库操作只保存子 Agent 执行，不再复制根 Turn 生命周期。

import type { SqliteDb } from '../../database/database.js';

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
/** agent_runs.context_mode 的 SQL CHECK 原样。 */
export type AgentRunContextModeRow = 'subagent' | 'fork';

export interface AgentRunRow {
  id:                  string;
  session_id:          string;
  parent_turn_id:      string;
  parent_agent_run_id: string | null;
  context_mode:        AgentRunContextModeRow;
  description:         string | null;
  provider_id:         string | null;
  model_id:            string | null;
  status:              AgentRunStatus;
  error:               string | null;
  iterations:          number | null;
  tool_call_count:     number | null;
  input_tokens:        number | null;
  output_tokens:       number | null;
  created_at:          number;
  updated_at:          number;
  completed_at:        number | null;
}

export interface AgentRunInsert {
  id: string;
  sessionId: string;
  parentTurnId: string;
  parentAgentRunId?: string;
  contextMode: AgentRunContextModeRow;
  description?: string;
  providerId?: string;
  modelId?: string;
  createdAt: number;
}

export interface AgentRunCompletion {
  iterations: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
}

export class AgentRunsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(value: AgentRunInsert): AgentRunRow | undefined {
    return this.db.prepare(
      `INSERT OR IGNORE INTO agent_runs (
         id, session_id, parent_turn_id, parent_agent_run_id,
         context_mode, description, provider_id, model_id, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
       RETURNING *`,
    ).get(
      value.id,
      value.sessionId,
      value.parentTurnId,
      value.parentAgentRunId ?? null,
      value.contextMode,
      value.description ?? null,
      value.providerId ?? null,
      value.modelId ?? null,
      value.createdAt,
      value.createdAt,
    ) as AgentRunRow | undefined;
  }

  // 终态迁移的唯一守卫是 status='running'：better-sqlite3 同步单写者，
  // findById 到 UPDATE 之间不存在交错。
  complete(
    id: string,
    completion: AgentRunCompletion,
    at: number,
  ): AgentRunRow | undefined {
    return this.db.prepare(
      `UPDATE agent_runs
          SET status = 'completed',
              error = NULL,
              iterations = ?,
              tool_call_count = ?,
              input_tokens = ?,
              output_tokens = ?,
              completed_at = ?,
              updated_at = ?
        WHERE id = ? AND status = 'running'
        RETURNING *`,
    ).get(
      completion.iterations,
      completion.toolCallCount,
      completion.inputTokens,
      completion.outputTokens,
      at,
      at,
      id,
    ) as AgentRunRow | undefined;
  }

  fail(
    id: string,
    error: string,
    at: number,
  ): AgentRunRow | undefined {
    return this.finish(id, 'failed', error, at);
  }

  cancel(
    id: string,
    reason: string,
    at: number,
  ): AgentRunRow | undefined {
    return this.finish(id, 'cancelled', reason, at);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM agent_runs WHERE id = ?').run(id);
  }

  deleteTerminalForSession(sessionId: string): number {
    return this.db.prepare(
      `DELETE FROM agent_runs
        WHERE session_id = ? AND status IN ('completed', 'failed', 'cancelled')`,
    ).run(sessionId).changes;
  }

  findById(id: string): AgentRunRow | undefined {
    return this.db.prepare(
      'SELECT * FROM agent_runs WHERE id = ?',
    ).get(id) as AgentRunRow | undefined;
  }

  listForSession(sessionId: string, limit = 200): AgentRunRow[] {
    return this.db.prepare(
      `SELECT * FROM agent_runs
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).all(sessionId, limit) as AgentRunRow[];
  }

  listRunning(): AgentRunRow[] {
    return this.db.prepare(
      `SELECT * FROM agent_runs
        WHERE status = 'running'
        ORDER BY created_at ASC, id ASC`,
    ).all() as AgentRunRow[];
  }

  markStuckFailed(at: number): AgentRunRow[] {
    return this.db.prepare(
      `UPDATE agent_runs
          SET status = 'failed',
              error = 'Process terminated unexpectedly',
              completed_at = ?,
              updated_at = ?
        WHERE status = 'running'
        RETURNING *`,
    ).all(at, at) as AgentRunRow[];
  }

  private finish(
    id: string,
    status: 'failed' | 'cancelled',
    error: string,
    at: number,
  ): AgentRunRow | undefined {
    return this.db.prepare(
      `UPDATE agent_runs
          SET status = ?,
              error = ?,
              completed_at = ?,
              updated_at = ?
        WHERE id = ? AND status = 'running'
        RETURNING *`,
    ).get(status, error, at, at, id) as AgentRunRow | undefined;
  }
}

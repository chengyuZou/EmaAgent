// Subagent 数据库操作只保存子 Agent 执行，不再复制根 Turn 生命周期。

import type { SqliteDb } from '../../database/database.js';

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled';
/** subagents.context_mode 的 SQL CHECK 原样。 */
export type SubagentContextModeRow = 'subagent' | 'fork';

export interface SubagentRow {
  id:                  string;
  session_id:          string;
  context_mode:        SubagentContextModeRow;
  description:         string | null;
  provider_id:         string | null;
  model_id:            string | null;
  status:              SubagentStatus;
  error:               string | null;
  iterations:          number | null;
  tool_call_count:     number | null;
  input_tokens:        number | null;
  output_tokens:       number | null;
  final_text:          string | null;
  created_at:          number;
  updated_at:          number;
  completed_at:        number | null;
}

export interface SubagentInsert {
  id: string;
  toolCallId: string;
  sessionId: string;
  contextMode: SubagentContextModeRow;
  description?: string;
  providerId?: string;
  modelId?: string;
  createdAt: number;
}

export interface SubagentInvocationRow {
  tool_call_id: string;
  subagent_id: string;
  created_at: number;
}

export interface SubagentSummaryRow {
  id:              string;
  session_id:      string;
  context_mode:    SubagentContextModeRow;
  description:     string | null;
  provider_id:     string | null;
  model_id:        string | null;
  status:          SubagentStatus;
  error:           string | null;
  iterations:      number | null;
  tool_call_count: number | null;
  input_tokens:    number | null;
  output_tokens:   number | null;
  created_at:      number;
  updated_at:      number;
  completed_at:    number | null;
}

export interface SubagentCompletion {
  iterations: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  finalText: string;
}

export class SubagentsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(value: SubagentInsert): SubagentRow | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        `INSERT OR IGNORE INTO subagents (
         id, session_id,
         context_mode, description, provider_id, model_id, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
       RETURNING *`,
      ).get(
        value.id,
        value.sessionId,
        value.contextMode,
        value.description ?? null,
        value.providerId ?? null,
        value.modelId ?? null,
        value.createdAt,
        value.createdAt,
      ) as SubagentRow | undefined;
      if (!row) return undefined;
      this.db.prepare(
        `INSERT INTO subagent_invocations (tool_call_id, subagent_id, created_at)
         VALUES (?, ?, ?)`,
      ).run(value.toolCallId, row.id, value.createdAt);
      return row;
    })();
  }

  listInvocationsForSession(sessionId: string): SubagentInvocationRow[] {
    return this.db.prepare(
      `SELECT invocation.tool_call_id, invocation.subagent_id, invocation.created_at
         FROM subagent_invocations invocation
         JOIN subagents subagent ON subagent.id = invocation.subagent_id
        WHERE subagent.session_id = ?
        ORDER BY invocation.created_at ASC, invocation.tool_call_id ASC`,
    ).all(sessionId) as SubagentInvocationRow[];
  }

  // 终态迁移的唯一守卫是 status='running'：better-sqlite3 同步单写者，
  // findById 到 UPDATE 之间不存在交错。
  complete(
    id: string,
    completion: SubagentCompletion,
    at: number,
  ): SubagentRow | undefined {
    return this.db.prepare(
      `UPDATE subagents
          SET status = 'completed',
              error = NULL,
              iterations = ?,
              tool_call_count = ?,
              input_tokens = ?,
              output_tokens = ?,
              final_text = ?,
              completed_at = ?,
              updated_at = ?
        WHERE id = ? AND status = 'running'
        RETURNING *`,
    ).get(
      completion.iterations,
      completion.toolCallCount,
      completion.inputTokens,
      completion.outputTokens,
      completion.finalText,
      at,
      at,
      id,
    ) as SubagentRow | undefined;
  }

  fail(
    id: string,
    error: string,
    at: number,
  ): SubagentRow | undefined {
    return this.finish(id, 'failed', error, at);
  }

  cancel(
    id: string,
    reason: string,
    at: number,
  ): SubagentRow | undefined {
    return this.finish(id, 'cancelled', reason, at);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM subagents WHERE id = ?').run(id);
  }

  deleteTerminalForSession(sessionId: string): number {
    return this.db.prepare(
      `DELETE FROM subagents
        WHERE session_id = ? AND status IN ('completed', 'failed', 'cancelled')`,
    ).run(sessionId).changes;
  }

  findById(id: string): SubagentRow | undefined {
    return this.db.prepare(
      'SELECT * FROM subagents WHERE id = ?',
    ).get(id) as SubagentRow | undefined;
  }

  listForSession(sessionId: string, limit = 200): SubagentSummaryRow[] {
    return this.db.prepare(
      `SELECT id, session_id, context_mode, description,
              provider_id, model_id, status, error, iterations, tool_call_count,
              input_tokens, output_tokens, created_at, updated_at, completed_at
         FROM subagents
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).all(sessionId, limit) as SubagentSummaryRow[];
  }

  findSummaryById(id: string): SubagentSummaryRow | undefined {
    return this.db.prepare(
      `SELECT id, session_id, context_mode, description,
              provider_id, model_id, status, error, iterations, tool_call_count,
              input_tokens, output_tokens, created_at, updated_at, completed_at
         FROM subagents
        WHERE id = ?`,
    ).get(id) as SubagentSummaryRow | undefined;
  }

  listRunning(): SubagentRow[] {
    return this.db.prepare(
      `SELECT * FROM subagents
        WHERE status = 'running'
        ORDER BY created_at ASC, id ASC`,
    ).all() as SubagentRow[];
  }

  markStuckFailed(at: number): SubagentRow[] {
    return this.db.prepare(
      `UPDATE subagents
          SET status = 'failed',
              error = 'Process terminated unexpectedly',
              completed_at = ?,
              updated_at = ?
        WHERE status = 'running'
        RETURNING *`,
    ).all(at, at) as SubagentRow[];
  }

  private finish(
    id: string,
    status: 'failed' | 'cancelled',
    error: string,
    at: number,
  ): SubagentRow | undefined {
    return this.db.prepare(
      `UPDATE subagents
          SET status = ?,
              error = ?,
              completed_at = ?,
              updated_at = ?
        WHERE id = ? AND status = 'running'
        RETURNING *`,
    ).get(status, error, at, at, id) as SubagentRow | undefined;
  }
}

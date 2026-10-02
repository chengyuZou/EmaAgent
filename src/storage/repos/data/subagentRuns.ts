// 保存每次子代理执行的事实, 状态和实际配置与身份行在同一事务内提交.
import type { SqliteDb } from '../../database/database.js';
import type { PermissionModeRow, ReasoningEffortRow } from './sessions.js';
import type { SubagentDetailsUpdate, SubagentStatusRow } from './subagents.js';

export type SubagentContextModeRow = 'subagent' | 'fork';

export interface SubagentRunRow {
  id: string;
  subagent_id: string;
  parent_tool_call_id: string | null;
  context_mode: SubagentContextModeRow;
  description: string | null;
  provider_id: string | null;
  model_id: string | null;
  protocol: string | null;
  permission_mode: PermissionModeRow | null;
  reasoning_effort: ReasoningEffortRow | null;
  status: SubagentStatusRow;
  error: string | null;
  iterations: number | null;
  tool_call_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  final_text: string | null;
  created_at: number;
  updated_at: number;
  /** 经过时间由 completed_at - created_at 取得, 不额外保存 duration_ms. */
  completed_at: number | null;
}

export interface SubagentRunInsert {
  id: string;
  subagentId: string;
  parentToolCallId?: string;
  contextMode: SubagentContextModeRow;
  description?: string;
  createdAt: number;
}

/** 准备成功后记录实际配置, 省略参数时选什么由执行装配方决定, 不由 SQL 猜测. */
export interface SubagentRunConfiguration {
  providerId: string;
  modelId: string;
  protocol: string;
  permissionMode: PermissionModeRow;
  reasoningEffort: ReasoningEffortRow;
}

export interface SubagentRunCompletion {
  iterations: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  finalText: string;
}

export interface SubagentRunPageCursor {
  createdAt: number;
  id: string;
}

export interface SubagentRunPage {
  items: SubagentRunRow[];
  nextCursor: SubagentRunPageCursor | null;
}

export class SubagentRunsRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 只插入首个 Run, 与新身份的原子创建由业务调用方持有外层事务. */
  insert(run: SubagentRunInsert): SubagentRunRow {
    return this.db.prepare(`
      INSERT INTO subagent_runs (
        id, subagent_id, parent_tool_call_id, context_mode, description, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(
      run.id, run.subagentId, run.parentToolCallId ?? null, run.contextMode,
      run.description ?? null, run.createdAt, run.createdAt,
    ) as SubagentRunRow;
  }

  /** 忙碌不改 Title、description 或身份状态; 其他约束错误仍然抛出. */
  startRun(run: SubagentRunInsert, details?: SubagentDetailsUpdate): SubagentRunRow | undefined {
    return this.db.transaction(() => {
      const inserted = this.insertRun(run);
      if (!inserted) return undefined;
      this.db.prepare(`
        UPDATE subagents SET status = 'running', updated_at = ?,
          title = COALESCE(?, title), description = COALESCE(?, description)
        WHERE id = ?
      `).run(run.createdAt, details?.title ?? null, details?.description ?? null, run.subagentId);
      return inserted;
    })();
  }

  setRunConfiguration(
    runId: string, configuration: SubagentRunConfiguration, at: number,
  ): SubagentRunRow | undefined {
    return this.db.transaction(() => {
      const updated = this.db.prepare(`
        UPDATE subagent_runs SET provider_id = ?, model_id = ?, protocol = ?,
          permission_mode = ?, reasoning_effort = ?, updated_at = ?
        WHERE id = ? AND status = 'running' RETURNING *
      `).get(
        configuration.providerId, configuration.modelId, configuration.protocol,
        configuration.permissionMode, configuration.reasoningEffort, at, runId,
      ) as SubagentRunRow | undefined;
      if (!updated) return undefined;
      this.db.prepare(`
        UPDATE subagents SET provider_id = ?, model_id = ?, protocol = ?,
          permission_mode = ?, reasoning_effort = ?, updated_at = ?
        WHERE id = ?
      `).run(
        configuration.providerId, configuration.modelId, configuration.protocol,
        configuration.permissionMode, configuration.reasoningEffort, at, updated.subagent_id,
      );
      return updated;
    })();
  }

  completeRun(runId: string, completion: SubagentRunCompletion, at: number): SubagentRunRow | undefined {
    return this.db.transaction(() => {
      const completed = this.db.prepare(`
        UPDATE subagent_runs SET status = 'completed', error = NULL,
          iterations = ?, tool_call_count = ?, input_tokens = ?, output_tokens = ?,
          final_text = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' RETURNING *
      `).get(
        completion.iterations, completion.toolCallCount, completion.inputTokens,
        completion.outputTokens, completion.finalText, at, at, runId,
      ) as SubagentRunRow | undefined;
      if (completed) this.syncStatus(completed, at);
      return completed;
    })();
  }

  failRun(runId: string, error: string, at: number): SubagentRunRow | undefined {
    return this.finishRun(runId, 'failed', error, at);
  }

  cancelRun(runId: string, reason: string, at: number): SubagentRunRow | undefined {
    return this.finishRun(runId, 'cancelled', reason, at);
  }

  findById(runId: string): SubagentRunRow | undefined {
    return this.db.prepare('SELECT * FROM subagent_runs WHERE id = ?')
      .get(runId) as SubagentRunRow | undefined;
  }

  findLatestRun(subagentId: string): SubagentRunRow | undefined {
    return this.db.prepare(`
      SELECT * FROM subagent_runs WHERE subagent_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(subagentId) as SubagentRunRow | undefined;
  }

  findRunningRun(subagentId: string): SubagentRunRow | undefined {
    return this.db.prepare("SELECT * FROM subagent_runs WHERE subagent_id = ? AND status = 'running'")
      .get(subagentId) as SubagentRunRow | undefined;
  }

  listForSubagent(subagentId: string, cursor?: SubagentRunPageCursor, limit = 50): SubagentRunPage {
    const pageSize = Math.min(Math.max(limit, 1), 200);
    const rows = this.db.prepare(`
      SELECT * FROM subagent_runs WHERE subagent_id = ? AND (
        ? IS NULL OR created_at < ? OR (created_at = ? AND id < ?)
      )
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(
      subagentId, cursor?.createdAt ?? null, cursor?.createdAt ?? null,
      cursor?.createdAt ?? null, cursor?.id ?? null, pageSize + 1,
    ) as SubagentRunRow[];
    const items = rows.slice(0, pageSize);
    const last = items[items.length - 1];
    let nextCursor: SubagentRunPageCursor | null = null;
    if (rows.length > pageSize && last) {
      nextCursor = { createdAt: last.created_at, id: last.id };
    }
    return { items, nextCursor };
  }

  listRunningRuns(): SubagentRunRow[] {
    return this.db.prepare("SELECT * FROM subagent_runs WHERE status = 'running' ORDER BY created_at, rowid")
      .all() as SubagentRunRow[];
  }

  markStuckRunsFailed(at: number): SubagentRunRow[] {
    return this.db.transaction(() => {
      const failed = this.db.prepare(`
        UPDATE subagent_runs SET status = 'failed', error = 'Process terminated unexpectedly',
          completed_at = ?, updated_at = ?
        WHERE status = 'running' RETURNING *
      `).all(at, at) as SubagentRunRow[];
      for (const run of failed) this.syncStatus(run, at);
      return failed;
    })();
  }

  private insertRun(run: SubagentRunInsert): SubagentRunRow | undefined {
    return this.db.prepare(`
      INSERT INTO subagent_runs (
        id, subagent_id, parent_tool_call_id, context_mode, description, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subagent_id) WHERE status = 'running' DO NOTHING RETURNING *
    `).get(
      run.id, run.subagentId, run.parentToolCallId ?? null, run.contextMode,
      run.description ?? null, run.createdAt, run.createdAt,
    ) as SubagentRunRow | undefined;
  }

  private syncStatus(run: SubagentRunRow, at: number): void {
    this.db.prepare('UPDATE subagents SET status = ?, updated_at = ? WHERE id = ?')
      .run(run.status, at, run.subagent_id);
  }

  private finishRun(
    runId: string, status: 'failed' | 'cancelled', error: string, at: number,
  ): SubagentRunRow | undefined {
    return this.db.transaction(() => {
      const finished = this.db.prepare(`
        UPDATE subagent_runs SET status = ?, error = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' RETURNING *
      `).get(status, error, at, at, runId) as SubagentRunRow | undefined;
      if (finished) this.syncStatus(finished, at);
      return finished;
    })();
  }
}

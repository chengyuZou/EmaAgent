// 管理稳定子代理身份与每次 Run, 首次创建的外层事务归本业务层.
import type {
  SqliteDb, SubagentPageCursor, SubagentRow, SubagentRunConfiguration,
  SubagentRunPageCursor, SubagentRunRow, SubagentRunsRepo, SubagentsRepo,
} from '@ema-agent/storage';
import type { Subagent, SubagentCompletion, SubagentRun, SubagentStart } from './types.js';

export class SubagentStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly subagents: SubagentsRepo,
    private readonly runs: SubagentRunsRepo,
  ) {}

  start(input: SubagentStart): SubagentRun {
    const now = Date.now();
    const run = {
      id: input.runId, subagentId: input.subagentId, parentToolCallId: input.toolCallId,
      contextMode: input.contextMode, description: input.description, createdAt: now,
    };
    if (input.isNew) {
      const { title, description } = input;
      if (!title || !description) throw new Error('新建子代理必须提供 title 和 description');
      return this.db.transaction(() => {
        this.subagents.insert({
          id: input.subagentId, sessionId: input.sessionId, title, description, createdAt: now,
        });
        return runFromRow(this.runs.insert(run));
      })();
    }
    const inserted = this.runs.startRun(run, { title: input.title, description: input.description });
    if (!inserted) throw new Error(`Subagent ${input.subagentId} 正在被占用`);
    return runFromRow(inserted);
  }

  setConfiguration(runId: string, configuration: SubagentRunConfiguration): void {
    if (!this.runs.setRunConfiguration(runId, configuration, Date.now())) {
      throw new Error(`Subagent Run ${runId} 无法写入配置`);
    }
  }

  complete(runId: string, completion: SubagentCompletion): void {
    if (!this.runs.completeRun(runId, completion, Date.now())) {
      throw new Error(`Subagent Run ${runId} 无法完成`);
    }
  }

  fail(runId: string, reason: string): void {
    if (!this.runs.failRun(runId, reason, Date.now())) {
      throw new Error(`Subagent Run ${runId} 无法写入失败终态`);
    }
  }

  cancel(runId: string, reason: string): void {
    if (!this.runs.cancelRun(runId, reason, Date.now())) throw new Error(`Subagent Run ${runId} 无法取消`);
  }

  get(subagentId: string): Subagent | undefined {
    const row = this.subagents.findById(subagentId);
    return row ? fromRow(row) : undefined;
  }

  getRun(runId: string): SubagentRun | undefined {
    const row = this.runs.findById(runId);
    return row ? runFromRow(row) : undefined;
  }

  latestRun(subagentId: string): SubagentRun | undefined {
    const row = this.runs.findLatestRun(subagentId);
    return row ? runFromRow(row) : undefined;
  }

  listForSession(sessionId: string, cursor?: SubagentPageCursor, limit?: number) {
    const page = this.subagents.listForSession(sessionId, cursor, limit);
    return { items: page.items.map(fromRow), nextCursor: page.nextCursor };
  }

  listRuns(subagentId: string, cursor?: SubagentRunPageCursor, limit?: number) {
    const page = this.runs.listForSubagent(subagentId, cursor, limit);
    return { items: page.items.map(runFromRow), nextCursor: page.nextCursor };
  }

  delete(subagentId: string): void {
    this.subagents.delete(subagentId);
  }

  clearTerminalForSession(sessionId: string): number {
    return this.subagents.deleteTerminalForSession(sessionId);
  }

  recoverInterrupted(): SubagentRun[] {
    return this.runs.markStuckRunsFailed(Date.now()).map(runFromRow);
  }
}

function fromRow(row: SubagentRow): Subagent {
  return {
    id: row.id, sessionId: row.session_id, title: row.title, description: row.description,
    permissionMode: row.permission_mode, providerId: row.provider_id, modelId: row.model_id,
    protocol: row.protocol, reasoningEffort: row.reasoning_effort, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function runFromRow(row: SubagentRunRow): SubagentRun {
  return {
    id: row.id, subagentId: row.subagent_id, parentToolCallId: row.parent_tool_call_id,
    contextMode: row.context_mode, description: row.description,
    providerId: row.provider_id, modelId: row.model_id, protocol: row.protocol,
    permissionMode: row.permission_mode, reasoningEffort: row.reasoning_effort,
    status: row.status, error: row.error, iterations: row.iterations,
    toolCallCount: row.tool_call_count, inputTokens: row.input_tokens,
    outputTokens: row.output_tokens, finalText: row.final_text,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
  };
}

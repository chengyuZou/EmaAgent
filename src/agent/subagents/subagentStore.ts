// 管理一次子 Agent 运行的状态机与终态统计（一次运行一行）。
// Assistant 的工具调用事实与完整消息、ToolResult 流水归 subagentMessagesStore.ts.

import type { SubagentRow, SubagentSummaryRow, SubagentsRepo } from '@ema-agent/storage';
import type {
  Subagent,
  SubagentCompletion,
  SubagentInvocation,
  SubagentStart,
  SubagentStatus,
  SubagentSummary,
} from './types.js';

function fromRow(row: SubagentRow): Subagent {
  return {
    id: row.id,
    sessionId: row.session_id,
    contextMode: row.context_mode,
    status: row.status as SubagentStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.provider_id !== null
      ? { providerId: row.provider_id }
      : {}),
    ...(row.model_id !== null ? { modelId: row.model_id } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.iterations !== null ? { iterations: row.iterations } : {}),
    ...(row.tool_call_count !== null ? { toolCallCount: row.tool_call_count } : {}),
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
    ...(row.final_text !== null ? { finalText: row.final_text } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

function summaryFromRow(row: SubagentSummaryRow): SubagentSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    contextMode: row.context_mode,
    status: row.status as SubagentStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.provider_id !== null ? { providerId: row.provider_id } : {}),
    ...(row.model_id !== null ? { modelId: row.model_id } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.iterations !== null ? { iterations: row.iterations } : {}),
    ...(row.tool_call_count !== null ? { toolCallCount: row.tool_call_count } : {}),
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

export class SubagentStore {
  constructor(private readonly repo: SubagentsRepo) {}

  start(input: SubagentStart): Subagent {
    const now = Date.now();
    const inserted = this.repo.insert({
      id: input.subagentId,
      toolCallId: input.toolCallId,
      sessionId: input.sessionId,
      contextMode: input.contextMode,
      description: input.description,
      providerId: input.providerId,
      modelId: input.modelId,
      createdAt: now,
    });
    if (!inserted) {
      throw new Error(`Subagent ${input.subagentId} 已存在`);
    }
    return fromRow(inserted);
  }

  complete(
    subagentId: string,
    completion: SubagentCompletion,
  ): void {
    const current = this.requireSubagent(subagentId);
    if (current.status === 'completed') return;
    if (current.status !== 'running') {
      throw new Error(`Subagent ${subagentId} 已处于 ${current.status}, 无法完成`);
    }
    const completed = this.repo.complete(subagentId, completion, Date.now());
    if (!completed) throw new Error(`Subagent ${subagentId} 完成状态写入失败`);
  }

  fail(subagentId: string, reason: string): void {
    const current = this.requireSubagent(subagentId);
    if (current.status === 'failed' && current.error === reason) return;
    if (current.status !== 'running') {
      throw new Error(`Subagent ${subagentId} 已处于 ${current.status}, 无法写入失败终态`);
    }
    const failed = this.repo.fail(subagentId, reason, Date.now());
    if (!failed) throw new Error(`Subagent ${subagentId} 失败状态写入失败`);
  }

  cancel(subagentId: string, reason: string): void {
    const current = this.requireSubagent(subagentId);
    if (current.status === 'cancelled') return;
    if (current.status !== 'running') {
      throw new Error(`Subagent ${subagentId} 已处于 ${current.status}, 无法取消`);
    }
    const cancelled = this.repo.cancel(subagentId, reason, Date.now());
    if (!cancelled) throw new Error(`Subagent ${subagentId} 取消状态写入失败`);
  }

  get(subagentId: string): Subagent | undefined {
    const row = this.repo.findById(subagentId);
    return row ? fromRow(row) : undefined;
  }

  getSummary(subagentId: string): SubagentSummary | undefined {
    const row = this.repo.findSummaryById(subagentId);
    return row ? summaryFromRow(row) : undefined;
  }

  listForSession(sessionId: string): SubagentSummary[] {
    return this.repo.listForSession(sessionId).map(summaryFromRow);
  }

  listInvocationsForSession(sessionId: string): SubagentInvocation[] {
    return this.repo.listInvocationsForSession(sessionId).map(row => ({
      toolCallId: row.tool_call_id,
      subagentId: row.subagent_id,
      createdAt: row.created_at,
    }));
  }

  delete(subagentId: string): void {
    this.repo.delete(subagentId);
  }

  clearTerminalForSession(sessionId: string): number {
    return this.repo.deleteTerminalForSession(sessionId);
  }

  recoverInterrupted(): Subagent[] {
    return this.repo.markStuckFailed(Date.now()).map(fromRow);
  }

  private requireSubagent(subagentId: string): SubagentRow {
    const row = this.repo.findById(subagentId);
    if (!row) throw new Error(`Subagent ${subagentId} 不存在`);
    return row;
  }
}

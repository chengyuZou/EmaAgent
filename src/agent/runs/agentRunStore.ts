// AgentRunStore 管理子 Agent 执行的 CAS 终态、查询和崩溃恢复。

import type { AgentRunId, SessionId } from '@ema-agent/ids';
import type { AgentRunRow, AgentRunsRepo } from '@ema-agent/storage';
import type {
  AgentRun,
  AgentRunCompletion,
  AgentRunStart,
  AgentRunStatus,
  AgentRunTransitionAction,
  AgentRunTransitionResult,
} from './types.js';

function fromRow(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentTurnId: row.parent_turn_id,
    kind: row.kind,
    status: row.status as AgentRunStatus,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.parent_agent_run_id !== null
      ? { parentAgentRunId: row.parent_agent_run_id }
      : {}),
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    ...(row.purpose !== null ? { purpose: row.purpose } : {}),
    ...(row.provider_config_id !== null
      ? { providerConfigId: row.provider_config_id }
      : {}),
    ...(row.model_id !== null ? { modelId: row.model_id } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.iterations !== null ? { iterations: row.iterations } : {}),
    ...(row.tool_call_count !== null ? { toolCallCount: row.tool_call_count } : {}),
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
    ...(row.output_excerpt !== null ? { outputExcerpt: row.output_excerpt } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

export class AgentRunStore {
  constructor(private readonly repo: AgentRunsRepo) {}

  start(input: AgentRunStart): AgentRun {
    const existing = this.repo.findById(input.agentRunId);
    if (existing) {
      const run = fromRow(existing);
      if (
        run.sessionId !== input.sessionId
        || run.parentTurnId !== input.parentTurnId
        || run.taskId !== input.taskId
        || run.kind !== input.kind
      ) {
        throw new Error(`AgentRun ${input.agentRunId} 已存在且身份不一致`);
      }
      return run;
    }

    const now = Date.now();
    const inserted = this.repo.insert({
      id: input.agentRunId,
      sessionId: input.sessionId,
      parentTurnId: input.parentTurnId,
      parentAgentRunId: input.parentAgentRunId,
      taskId: input.taskId,
      kind: input.kind,
      purpose: input.purpose,
      providerConfigId: input.providerConfigId,
      modelId: input.modelId,
      createdAt: now,
    });
    if (!inserted) {
      const raced = this.repo.findById(input.agentRunId);
      if (raced) return fromRow(raced);
      throw new Error(`AgentRun ${input.agentRunId} 创建失败`);
    }
    return fromRow(inserted);
  }

  complete(
    agentRunId: AgentRunId,
    completion: AgentRunCompletion,
  ): AgentRunTransitionResult {
    const current = this.currentFor('complete', agentRunId);
    if (!current.ok) return current.result;
    if (current.row.status === 'completed') {
      return { ok: true, changed: false, run: fromRow(current.row) };
    }
    if (current.row.status !== 'running') {
      return this.conflict('complete', current.row);
    }
    return this.finishTransition(
      'complete',
      agentRunId,
      this.repo.complete(agentRunId, current.row.version, completion, Date.now()),
    );
  }

  fail(agentRunId: AgentRunId, reason: string): AgentRunTransitionResult {
    const current = this.currentFor('fail', agentRunId);
    if (!current.ok) return current.result;
    if (current.row.status === 'failed' && current.row.error === reason) {
      return { ok: true, changed: false, run: fromRow(current.row) };
    }
    if (current.row.status !== 'running') return this.conflict('fail', current.row);
    return this.finishTransition(
      'fail',
      agentRunId,
      this.repo.fail(agentRunId, current.row.version, reason, Date.now()),
    );
  }

  cancel(agentRunId: AgentRunId, reason: string): AgentRunTransitionResult {
    const current = this.currentFor('cancel', agentRunId);
    if (!current.ok) return current.result;
    if (current.row.status === 'cancelled') {
      return { ok: true, changed: false, run: fromRow(current.row) };
    }
    if (current.row.status !== 'running') return this.conflict('cancel', current.row);
    return this.finishTransition(
      'cancel',
      agentRunId,
      this.repo.cancel(agentRunId, current.row.version, reason, Date.now()),
    );
  }

  get(agentRunId: AgentRunId): AgentRun | undefined {
    const row = this.repo.findById(agentRunId);
    return row ? fromRow(row) : undefined;
  }

  listForSession(sessionId: SessionId): AgentRun[] {
    return this.repo.listForSession(sessionId).map(fromRow);
  }

  delete(agentRunId: AgentRunId): void {
    this.repo.delete(agentRunId);
  }

  clearTerminalForSession(sessionId: SessionId): number {
    return this.repo.deleteTerminalForSession(sessionId);
  }

  recoverInterrupted(): AgentRun[] {
    return this.repo.markStuckFailed(Date.now()).map(fromRow);
  }

  private currentFor(
    action: AgentRunTransitionAction,
    agentRunId: AgentRunId,
  ):
    | { ok: true; row: AgentRunRow }
    | { ok: false; result: AgentRunTransitionResult } {
    const row = this.repo.findById(agentRunId);
    if (row) return { ok: true, row };
    return { ok: false, result: { ok: false, reason: 'not_found', action } };
  }

  private finishTransition(
    action: AgentRunTransitionAction,
    agentRunId: AgentRunId,
    updated: AgentRunRow | undefined,
  ): AgentRunTransitionResult {
    if (updated) return { ok: true, changed: true, run: fromRow(updated) };
    const current = this.repo.findById(agentRunId);
    return current
      ? this.conflict(action, current)
      : { ok: false, reason: 'not_found', action };
  }

  private conflict(
    action: AgentRunTransitionAction,
    row: AgentRunRow,
  ): AgentRunTransitionResult {
    return {
      ok: false,
      reason: 'conflict',
      action,
      current: fromRow(row),
    };
  }
}

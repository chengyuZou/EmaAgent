// 以 CAS 保存 Tool 调用的副作用边界，供崩溃恢复判断是否可以安全重试。
import { ToolExecutionStateConflictError } from '../errors.js';

export type ToolExecutionStatus =
  | 'prepared'
  | 'authorized'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';

/** 一次 Tool 调用的薄执行状态；完整输入和结果都由 Message 保存。 */
export interface ToolExecutionRecord {
  callId: string;
  sessionId: string;
  turnId: string;
  agentRunId?: string;
  toolName: string;
  status: ToolExecutionStatus;
  startedAt?: number;
  completedAt?: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface ToolExecutionPrepareRecord {
  callId: string;
  sessionId: string;
  turnId: string;
  agentRunId?: string;
  toolName: string;
  createdAt: number;
}

/** Storage 实现原子读写，Tools 保留状态转换和恢复语义。 */
export interface ToolExecutionStateStore {
  insertPrepared(value: ToolExecutionPrepareRecord): ToolExecutionRecord | undefined;
  findByCallId(callId: string): ToolExecutionRecord | undefined;
  listForTurn(turnId: string): ToolExecutionRecord[];
  transition(
    callId: string,
    expectedVersion: number,
    from: readonly ToolExecutionStatus[],
    to: ToolExecutionStatus,
    at: number,
    terminal?: { completedAt: number },
  ): ToolExecutionRecord | undefined;
  listInterrupted(): ToolExecutionRecord[];
}

/**
 * 工具执行状态机，执行链与恢复器共同依赖的具体入口。
 *
 * 执行器只能通过该入口推进状态；每一步使用 version CAS，防止取消流程、
 * 迟到的工具 Promise 和崩溃恢复互相覆盖。
 */
export class ToolExecutionState {
  constructor(private readonly store: ToolExecutionStateStore) {}

  prepare(args: {
    callId: string;
    sessionId: string;
    turnId: string;
    agentRunId?: string;
    toolName: string;
  }): ToolExecutionRecord {
    const now = Date.now();

    const inserted = this.store.insertPrepared({
      callId: args.callId,
      sessionId: args.sessionId,
      turnId: args.turnId,
      agentRunId: args.agentRunId,
      toolName: args.toolName,
      createdAt: now,
    });
    if (inserted) return inserted;

    const existing = this.store.findByCallId(args.callId);
    if (
      !existing
      || existing.sessionId !== args.sessionId
      || existing.turnId !== args.turnId
      || existing.agentRunId !== args.agentRunId
      || existing.toolName !== args.toolName
    ) {
      throw new ToolExecutionStateConflictError(
        args.callId,
        ['prepared'],
        existing?.status,
      );
    }
    return existing;
  }

  authorize(callId: string): ToolExecutionRecord {
    return this.move(callId, ['prepared'], 'authorized');
  }

  start(callId: string): ToolExecutionRecord {
    return this.move(callId, ['authorized'], 'running');
  }

  succeed(callId: string): ToolExecutionRecord {
    return this.move(callId, ['running'], 'succeeded');
  }

  fail(callId: string): ToolExecutionRecord {
    return this.move(callId, ['prepared', 'authorized', 'running'], 'failed');
  }

  cancel(callId: string): ToolExecutionRecord {
    return this.move(callId, ['prepared', 'authorized'], 'cancelled');
  }

  outcomeUnknown(callId: string): ToolExecutionRecord {
    return this.move(callId, ['running'], 'outcome_unknown');
  }

  listForTurn(turnId: string): ToolExecutionRecord[] {
    return this.store.listForTurn(turnId);
  }

  listInterrupted(): ToolExecutionRecord[] {
    return this.store.listInterrupted();
  }

  completeFromMessage(
    callId: string,
    result: { isError?: boolean; errorCode?: string },
  ): ToolExecutionRecord {
    const terminal = result.errorCode === 'tool/outcome_unknown'
      ? 'outcome_unknown'
      : result.errorCode === 'tool/cancelled'
        ? 'cancelled'
        : result.isError
          ? 'failed'
          : 'succeeded';
    return this.move(
      callId,
      ['prepared', 'authorized', 'running'],
      terminal,
    );
  }

  private move(
    callId: string,
    from: readonly ToolExecutionStatus[],
    to: ToolExecutionStatus,
  ): ToolExecutionRecord {
    const current = this.store.findByCallId(callId);
    if (!current) throw new ToolExecutionStateConflictError(callId, from);

    const now = Date.now();
    const updated = this.store.transition(
      callId,
      current.version,
      from,
      to,
      now,
      isTerminal(to) ? { completedAt: now } : undefined,
    );
    if (updated) return updated;

    const latest = this.store.findByCallId(callId);
    throw new ToolExecutionStateConflictError(callId, from, latest?.status);
  }
}

function isTerminal(status: ToolExecutionStatus): boolean {
  return status === 'succeeded'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'outcome_unknown';
}

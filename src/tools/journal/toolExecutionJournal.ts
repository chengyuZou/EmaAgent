// 工具执行日志以 CAS 推进副作用状态，并在进程重启后保守标记未完成调用。

import { createHash } from 'node:crypto';
import type { AgentRunId, SessionId, ToolCallId, TurnId } from '@ema-agent/ids';

const RESULT_PREVIEW_LIMIT = 4_096;

export type ToolExecutionStatus =
  | 'prepared'
  | 'authorized'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';

/** 一次工具调用的持久化执行审计记录。 */
export interface ToolExecutionRecord {
  callId: ToolCallId;
  sessionId: SessionId;
  turnId: TurnId;
  agentRunId?: AgentRunId;
  toolName: string;
  inputJson: string;
  inputDigest: string;
  status: ToolExecutionStatus;
  resultPreview?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: number;
  completedAt?: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface ToolExecutionPrepareRecord {
  callId: ToolCallId;
  sessionId: SessionId;
  turnId: TurnId;
  agentRunId?: AgentRunId;
  toolName: string;
  inputJson: string;
  inputDigest: string;
  createdAt: number;
}

export interface ToolExecutionTerminalDetails {
  resultPreview?: string;
  errorCode?: string;
  errorMessage?: string;
  completedAt: number;
}

/** Storage 实现原子读写，Tools 保留状态转换和恢复语义。 */
export interface ToolExecutionJournalStore {
  insertPrepared(value: ToolExecutionPrepareRecord): ToolExecutionRecord | undefined;
  findByCallId(callId: ToolCallId): ToolExecutionRecord | undefined;
  listForTurn(turnId: TurnId): ToolExecutionRecord[];
  transition(
    callId: ToolCallId,
    expectedVersion: number,
    from: readonly ToolExecutionStatus[],
    to: ToolExecutionStatus,
    at: number,
    terminal?: ToolExecutionTerminalDetails,
  ): ToolExecutionRecord | undefined;
  recoverInterrupted(at: number): ToolExecutionRecord[];
}

/** Agent 只依赖该端口，不接触 SQL Repo 或 Journal 的具体实现。 */
export interface ToolExecutionJournalPort {
  prepare(args: {
    callId: ToolCallId;
    sessionId: SessionId;
    turnId: TurnId;
    agentRunId?: AgentRunId;
    toolName: string;
    input: unknown;
  }): ToolExecutionRecord;
  authorize(callId: ToolCallId): ToolExecutionRecord;
  start(callId: ToolCallId): ToolExecutionRecord;
  succeed(callId: ToolCallId, output: unknown): ToolExecutionRecord;
  fail(callId: ToolCallId, errorCode: string, errorMessage: string): ToolExecutionRecord;
  cancel(callId: ToolCallId, reason: string): ToolExecutionRecord;
  outcomeUnknown(callId: ToolCallId, reason: string): ToolExecutionRecord;
}

export class ToolExecutionJournalConflictError extends Error {
  constructor(
    readonly callId: ToolCallId,
    readonly expected: readonly ToolExecutionStatus[],
    readonly actual?: ToolExecutionStatus,
  ) {
    super(
      actual
        ? `工具调用 ${callId} 状态冲突：期望 ${expected.join('/')}，实际 ${actual}`
        : `工具调用 ${callId} 不存在`,
    );
    this.name = 'ToolExecutionJournalConflictError';
  }
}

/**
 * 工具执行状态机。
 *
 * 执行器只能通过该入口推进状态；每一步使用 version CAS，防止取消流程、
 * 迟到的工具 Promise 和崩溃恢复互相覆盖。
 */
export class ToolExecutionJournal implements ToolExecutionJournalPort {
  constructor(private readonly store: ToolExecutionJournalStore) {}

  prepare(args: {
    callId: ToolCallId;
    sessionId: SessionId;
    turnId: TurnId;
    agentRunId?: AgentRunId;
    toolName: string;
    input: unknown;
  }): ToolExecutionRecord {
    const inputJson = stableStringify(args.input);
    const inputDigest = createHash('sha256').update(inputJson, 'utf8').digest('hex');
    const now = Date.now();

    const inserted = this.store.insertPrepared({
      callId: args.callId,
      sessionId: args.sessionId,
      turnId: args.turnId,
      agentRunId: args.agentRunId,
      toolName: args.toolName,
      inputJson,
      inputDigest,
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
      || existing.inputDigest !== inputDigest
    ) {
      throw new ToolExecutionJournalConflictError(
        args.callId,
        ['prepared'],
        existing?.status,
      );
    }
    return existing;
  }

  authorize(callId: ToolCallId): ToolExecutionRecord {
    return this.move(callId, ['prepared'], 'authorized');
  }

  start(callId: ToolCallId): ToolExecutionRecord {
    return this.move(callId, ['authorized'], 'running');
  }

  succeed(callId: ToolCallId, output: unknown): ToolExecutionRecord {
    return this.move(callId, ['running'], 'succeeded', {
      resultPreview: preview(output),
    });
  }

  fail(callId: ToolCallId, errorCode: string, errorMessage: string): ToolExecutionRecord {
    return this.move(callId, ['prepared', 'authorized', 'running'], 'failed', {
      errorCode,
      errorMessage,
    });
  }

  cancel(callId: ToolCallId, reason: string): ToolExecutionRecord {
    return this.move(callId, ['prepared', 'authorized'], 'cancelled', {
      errorCode: 'tool/cancelled',
      errorMessage: reason,
    });
  }

  outcomeUnknown(callId: ToolCallId, reason: string): ToolExecutionRecord {
    return this.move(callId, ['running'], 'outcome_unknown', {
      errorCode: 'tool/outcome_unknown',
      errorMessage: reason,
    });
  }

  get(callId: ToolCallId): ToolExecutionRecord | undefined {
    return this.store.findByCallId(callId);
  }

  listForTurn(turnId: TurnId): ToolExecutionRecord[] {
    return this.store.listForTurn(turnId);
  }

  recoverInterrupted(): ToolExecutionRecord[] {
    return this.store.recoverInterrupted(Date.now());
  }

  private move(
    callId: ToolCallId,
    from: readonly ToolExecutionStatus[],
    to: ToolExecutionStatus,
    details?: Omit<ToolExecutionTerminalDetails, 'completedAt'>,
  ): ToolExecutionRecord {
    const current = this.store.findByCallId(callId);
    if (!current) throw new ToolExecutionJournalConflictError(callId, from);

    const now = Date.now();
    const updated = this.store.transition(
      callId,
      current.version,
      from,
      to,
      now,
      isTerminal(to) ? { ...details, completedAt: now } : undefined,
    );
    if (updated) return updated;

    const latest = this.store.findByCallId(callId);
    throw new ToolExecutionJournalConflictError(callId, from, latest?.status);
  }
}

function isTerminal(status: ToolExecutionStatus): boolean {
  return status === 'succeeded'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'outcome_unknown';
}

function preview(value: unknown): string {
  const serialized = typeof value === 'string' ? value : stableStringify(value);
  return serialized.length <= RESULT_PREVIEW_LIMIT
    ? serialized
    : `${serialized.slice(0, RESULT_PREVIEW_LIMIT)}\n[结果预览已截断]`;
}

/** 对 JSON 对象键排序，确保同一输入在不同运行中产生相同摘要。 */
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (current: unknown, inArray: boolean): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return current;
    }
    if (typeof current === 'number') return Number.isFinite(current) ? current : null;
    if (current === undefined || typeof current === 'function' || typeof current === 'symbol') {
      return inArray ? null : undefined;
    }
    if (typeof current === 'bigint') throw new TypeError('工具输入不能包含 bigint');
    if (typeof current !== 'object') return current;
    if (seen.has(current)) throw new TypeError('工具输入不能包含循环引用');
    seen.add(current);
    try {
      if (Array.isArray(current)) return current.map(item => normalize(item, true));
      const object = current as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(object).sort()) {
        const normalized = normalize(object[key], false);
        if (normalized !== undefined) sorted[key] = normalized;
      }
      return sorted;
    } finally {
      seen.delete(current);
    }
  };

  return JSON.stringify(normalize(value, false) ?? null);
}

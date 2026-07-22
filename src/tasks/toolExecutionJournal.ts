// 这里记录每次工具调用的执行状态推进（prepared->authorized->running->succeeded/failed），用 version CAS 防过期覆盖。

import { createHash } from 'node:crypto';
import type { SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import type { ToolExecutionRecord, ToolExecutionStatus } from '@ema-agent/tools';
import type { ToolExecutionRow, ToolExecutionsRepo } from '@ema-agent/storage';

const RESULT_PREVIEW_LIMIT = 4_096;

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
 * 工具执行日志 Facade。
 *
 * Agent 只能通过本 Facade 推进状态，不能直接操作 SQL。每一步使用 version CAS，
 * 防止终止流程、迟到的工具 Promise 和崩溃恢复互相覆盖。
 */
export class ToolExecutionJournal {
  constructor(private readonly repo: ToolExecutionsRepo) {}

  prepare(args: {
    callId: ToolCallId;
    sessionId: SessionId;
    turnId: TurnId;
    toolName: string;
    input: unknown;
  }): ToolExecutionRecord {
    const inputJson = stableStringify(args.input);
    const inputDigest = createHash('sha256').update(inputJson, 'utf8').digest('hex');
    const now = Date.now();

    const inserted = this.repo.insertPrepared({
      callId: args.callId,
      sessionId: args.sessionId,
      turnId: args.turnId,
      toolName: args.toolName,
      inputJson,
      inputDigest,
      createdAt: now,
    });
    if (inserted) return rowToRecord(inserted);

    const existing = this.repo.findByCallId(args.callId);
    if (
      !existing
      || existing.session_id !== args.sessionId
      || existing.turn_id !== args.turnId
      || existing.tool_name !== args.toolName
      || existing.input_digest !== inputDigest
    ) {
      throw new ToolExecutionJournalConflictError(
        args.callId,
        ['prepared'],
        existing?.status,
      );
    }
    return rowToRecord(existing);
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
    const row = this.repo.findByCallId(callId);
    return row ? rowToRecord(row) : undefined;
  }

  listForTurn(turnId: TurnId): ToolExecutionRecord[] {
    return this.repo.listForTurn(turnId).map(rowToRecord);
  }

  recoverInterrupted(): ToolExecutionRecord[] {
    return this.repo.recoverInterrupted(Date.now()).map(rowToRecord);
  }

  private move(
    callId: ToolCallId,
    from: readonly ToolExecutionStatus[],
    to: ToolExecutionStatus,
    details?: { resultPreview?: string; errorCode?: string; errorMessage?: string },
  ): ToolExecutionRecord {
    const current = this.repo.findByCallId(callId);
    if (!current) throw new ToolExecutionJournalConflictError(callId, from);

    const updated = this.repo.transition(
      callId,
      current.version,
      from,
      to,
      Date.now(),
      isTerminal(to)
        ? { ...details, completedAt: Date.now() }
        : undefined,
    );
    if (updated) return rowToRecord(updated);

    const latest = this.repo.findByCallId(callId);
    throw new ToolExecutionJournalConflictError(callId, from, latest?.status);
  }
}

function rowToRecord(row: ToolExecutionRow): ToolExecutionRecord {
  return {
    callId: row.call_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    toolName: row.tool_name,
    inputJson: row.input_json,
    inputDigest: row.input_digest,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.result_preview !== null ? { resultPreview: row.result_preview } : {}),
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
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
    if (typeof current === 'bigint') {
      throw new TypeError('工具输入不能包含 bigint');
    }
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

  const normalized = normalize(value, false);
  return JSON.stringify(normalized ?? null);
}

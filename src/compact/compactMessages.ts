// 依次执行阈值判断、微压缩、安全切割、摘要压缩和 Session 级失败熔断。

import { randomUUID } from 'node:crypto';
import { asCompactId, type CompactId, type SessionId } from '@ema-agent/ids';
import type { LanguageModel, Message } from '@ema-agent/llm';
import { estimateMessagesTokens } from '@ema-agent/token';
import { fitCompactHistory } from './budget.js';
import { runMacroCompact } from './macroCompact.js';
import { microCompact } from './microCompact.js';
import { findSafeCutPoint, findSafeCutPointAtOrAfter } from './safeCut.js';
import {
  DEFAULT_COMPACT_SETTINGS,
  type CompactRequest,
  type CompactResult,
  type CompactSettings,
} from './types.js';

const MIN_SUMMARY_BUDGET_TOKENS = 256;

export class CompactMessages {
  private readonly settings: CompactSettings;
  private readonly consecutiveFailures = new Map<SessionId, number>();

  constructor(
    private readonly llm: LanguageModel,
    overrides: Partial<CompactSettings> = {},
  ) {
    this.settings = { ...DEFAULT_COMPACT_SETTINGS, ...overrides };
  }

  async compact(request: CompactRequest): Promise<CompactResult> {
    validateRequest(request);
    request.signal?.throwIfAborted();

    const settings = request.settings ?? this.settings;
    const startedAt = Date.now();
    const history = [...request.history];
    const originalHistoryTokens = estimateMessagesTokens(history);
    const tokensOutsideHistory = Math.max(
      0,
      request.estimatedInputTokens - originalHistoryTokens,
    );
    const estimate = (candidate: readonly Message[]): number => Math.max(
      0,
      tokensOutsideHistory + estimateMessagesTokens([...candidate]),
    );
    const beforeTokens = request.estimatedInputTokens;

    if (history.length === 0) return unchanged('empty_history', history, beforeTokens);
    if (!settings.enabled && !request.force) {
      return unchanged('disabled', history, beforeTokens);
    }

    const reservedOutputTokens = Math.min(
      request.maxOutputTokens ?? settings.defaultReservedOutputTokens,
      settings.maximumReservedOutputTokens,
    );
    const tokenLimit = Math.max(
      1,
      request.contextWindow - reservedOutputTokens - settings.bufferTokens,
    );

    if (!request.force && beforeTokens <= tokenLimit) {
      return unchanged('below_threshold', history, beforeTokens);
    }
    if (
      !request.force &&
      this.failureCount(request.sessionId) >= settings.maximumConsecutiveFailures
    ) {
      return skipped(
        '连续自动压缩失败次数已达上限；响应式压缩仍可进行最后一次恢复尝试',
        history,
        beforeTokens,
      );
    }

    const micro = microCompact(history, {
      keepRecent: settings.keepRecentToolResults,
    });
    const afterMicroTokens = estimate(micro.messages);
    if (!request.force && afterMicroTokens <= tokenLimit) {
      this.consecutiveFailures.delete(request.sessionId);
      return {
        status: 'completed',
        method: 'micro',
        history: micro.messages,
        microCleared: micro.cleared,
        beforeTokens,
        afterTokens: afterMicroTokens,
        savedTokens: Math.max(0, beforeTokens - afterMicroTokens),
      };
    }

    const desiredCut = preferredCut(micro.messages.length);
    const safeCut = chooseSafeCut({
      messages: micro.messages,
      desiredCut,
      tokensOutsideHistory,
      tokenLimit,
    });
    const head = micro.messages.slice(0, safeCut);
    const tail = micro.messages.slice(safeCut);
    const compactId = asCompactId(randomUUID());
    request.emit?.({
      type: 'compact_started',
      compactId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      beforeTokens,
    });

    let macro: Awaited<ReturnType<typeof runMacroCompact>>;
    try {
      macro = await runMacroCompact({
        llm: this.llm,
        providerId: request.providerId,
        model: request.model,
        executionProfile: request.executionProfile,
        toCompact: head,
        modelContextWindow: request.contextWindow,
        signal: request.signal,
      });
    } catch (error) {
      if (!isAbort(error, request.signal)) throw error;
      request.emit?.({
        type: 'compact_cancelled',
        compactId,
        sessionId: request.sessionId,
        turnId: request.turnId,
        beforeTokens,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
    if (!macro.succeeded) {
      return this.fail({
        request,
        compactId,
        originalHistory: history,
        beforeTokens,
        reason: 'macro_failed',
        detail: macro.detail,
        startedAt,
      });
    }

    const fitted = fitCompactHistory({
      summary: macro.summary,
      tail,
      executionProfile: request.executionProfile,
      tokenLimit,
      tokensOutsideHistory,
    });
    if (!fitted) {
      return this.fail({
        request,
        compactId,
        originalHistory: history,
        beforeTokens,
        reason: 'budget_exceeded',
        detail: `摘要与近期历史无法放入 ${tokenLimit} Token 的历史预算`,
        startedAt,
      });
    }

    this.consecutiveFailures.delete(request.sessionId);
    request.emit?.({
      type: 'compact_completed',
      compactId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      beforeTokens,
      afterTokens: fitted.afterTokens,
      savedTokens: Math.max(0, beforeTokens - fitted.afterTokens),
      durationMs: Date.now() - startedAt,
    });
    return {
      status: 'completed',
      method: 'macro',
      history: fitted.history,
      summary: fitted.summary,
      microCleared: micro.cleared,
      beforeTokens,
      afterTokens: fitted.afterTokens,
      savedTokens: Math.max(0, beforeTokens - fitted.afterTokens),
    };
  }

  private failureCount(sessionId: SessionId): number {
    return this.consecutiveFailures.get(sessionId) ?? 0;
  }

  private fail(args: {
    readonly request: CompactRequest;
    readonly compactId: CompactId;
    readonly originalHistory: Message[];
    readonly beforeTokens: number;
    readonly reason: Extract<CompactResult, { status: 'failed' }>['reason'];
    readonly detail: string;
    readonly startedAt: number;
  }): Extract<CompactResult, { status: 'failed' }> {
    this.consecutiveFailures.set(
      args.request.sessionId,
      this.failureCount(args.request.sessionId) + 1,
    );
    args.request.emit?.({
      type: 'compact_failed',
      compactId: args.compactId,
      sessionId: args.request.sessionId,
      turnId: args.request.turnId,
      error: args.detail,
      beforeTokens: args.beforeTokens,
      afterTokens: args.beforeTokens,
      durationMs: Date.now() - args.startedAt,
    });
    return {
      status: 'failed',
      reason: args.reason,
      detail: args.detail,
      history: args.originalHistory,
      microCleared: 0,
      beforeTokens: args.beforeTokens,
      afterTokens: args.beforeTokens,
      savedTokens: 0,
    };
  }
}

function preferredCut(messageCount: number): number {
  if (messageCount <= 1) return messageCount;
  const tailSize = messageCount <= 8
    ? 1
    : Math.max(8, Math.ceil(messageCount * 0.25));
  return Math.max(1, messageCount - tailSize);
}

function chooseSafeCut(args: {
  readonly messages: readonly Message[];
  readonly desiredCut: number;
  readonly tokensOutsideHistory: number;
  readonly tokenLimit: number;
}): number {
  let cut = findSafeCutPoint([...args.messages], args.desiredCut);
  while (cut < args.messages.length) {
    const tail = args.messages.slice(cut);
    const tailTokens = args.tokensOutsideHistory + estimateMessagesTokens([...tail]);
    if (tailTokens + MIN_SUMMARY_BUDGET_TOKENS < args.tokenLimit) return cut;
    cut = findSafeCutPointAtOrAfter([...args.messages], cut + 1);
  }
  return args.messages.length;
}

function validateRequest(request: CompactRequest): void {
  if (!Number.isFinite(request.estimatedInputTokens) || request.estimatedInputTokens < 0) {
    throw new RangeError('estimatedInputTokens 必须是非负有限数值');
  }
  if (!Number.isFinite(request.contextWindow) || request.contextWindow <= 0) {
    throw new RangeError('contextWindow 必须是正有限数值');
  }
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isFinite(request.maxOutputTokens) || request.maxOutputTokens < 0)
  ) {
    throw new RangeError('maxOutputTokens 必须是非负有限数值');
  }
  if (request.history.some((message) => message.role === 'system')) {
    throw new TypeError('CompactRequest.history 不能包含 System Prompt');
  }
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

function unchanged(
  reason: Extract<CompactResult, { status: 'not_needed' }>['reason'],
  history: Message[],
  tokenCount: number,
): Extract<CompactResult, { status: 'not_needed' }> {
  return {
    status: 'not_needed',
    reason,
    history,
    microCleared: 0,
    beforeTokens: tokenCount,
    afterTokens: tokenCount,
    savedTokens: 0,
  };
}

function skipped(
  detail: string,
  history: Message[],
  tokenCount: number,
): Extract<CompactResult, { status: 'skipped' }> {
  return {
    status: 'skipped',
    reason: 'circuit_open',
    detail,
    history,
    microCleared: 0,
    beforeTokens: tokenCount,
    afterTokens: tokenCount,
    savedTokens: 0,
  };
}

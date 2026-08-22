// 依次执行阈值判断、微压缩、安全切割、摘要压缩和 Session 级失败熔断。

import { randomUUID } from 'node:crypto';
import type { CallLlm, Message } from '@ema-agent/llm';
import { estimateMessagesTokens } from '@ema-agent/token';
import { fitCompactHistory } from './budget.js';
import { runMacroCompact } from './macroCompact.js';
import { microCompact } from './microCompact.js';
import { findSafeCutPoint, findSafeCutPointAtOrAfter } from './safeCut.js';
import {
  DEFAULT_COMPACT_SETTINGS,
  type CompactSettings,
} from './settings.js';
import type {
  CompactRequest,
  CompactResult,
} from './types.js';

const MIN_SUMMARY_BUDGET_TOKENS = 256;

/**
 * 建立一个带 Session 级失败熔断的压缩函数。
 *
 * 闭包只保存连续失败次数，不保存 Message、Prompt 或 Session 数据。这样既保留
 * Claude 风格的函数管线，也避免把跨调用状态藏进一个大型 Manager 类。
 */
export function createCompact(
  callLlm: CallLlm,
  overrides: Partial<CompactSettings> = {},
): (request: CompactRequest) => Promise<CompactResult> {
  const defaults = { ...DEFAULT_COMPACT_SETTINGS, ...overrides };
  const consecutiveFailures = new Map<string, number>();

  return (request) => compactMessages({
    request,
    callLlm,
    defaults,
    consecutiveFailures,
  });
}

async function compactMessages(args: {
  readonly request: CompactRequest;
  readonly callLlm: CallLlm;
  readonly defaults: Readonly<CompactSettings>;
  readonly consecutiveFailures: Map<string, number>;
}): Promise<CompactResult> {
  const { request } = args;
  validateRequest(request);
  request.signal?.throwIfAborted();

  const settings = request.settings ?? args.defaults;
  const startedAt = Date.now();
  const history = [...request.history];
  const unchanged = (): CompactResult => ({ kind: 'unchanged', history });
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

  if (history.length === 0) return unchanged();
  if (!settings.enabled && !request.force) return unchanged();

  const reservedOutputTokens = Math.min(
    request.maxOutputTokens ?? settings.defaultReservedOutputTokens,
    settings.maximumReservedOutputTokens,
  );
  const tokenLimit = Math.max(
    1,
    request.contextWindow - reservedOutputTokens - settings.bufferTokens,
  );

  if (!request.force && beforeTokens <= tokenLimit) return unchanged();
  if (
    !request.force
    && failureCount(args.consecutiveFailures, request.sessionId)
      >= settings.maximumConsecutiveFailures
  ) {
    return unchanged();
  }

  const micro = microCompact(history, {
    keepRecent: settings.keepRecentToolResults,
  });
  const afterMicroTokens = estimate(micro);
  if (!request.force && afterMicroTokens <= tokenLimit) {
    args.consecutiveFailures.delete(request.sessionId);
    return { kind: 'micro', history: micro };
  }

  const safeCut = chooseSafeCut({
    messages: micro,
    desiredCut: preferredCut(micro.length),
    tokensOutsideHistory,
    tokenLimit,
  });
  const head = micro.slice(0, safeCut);
  const tail = micro.slice(safeCut);
  const compactId = randomUUID();
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
      callLlm: args.callLlm,
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
    recordFailure({
      request,
      compactId,
      beforeTokens,
      detail: macro.detail,
      startedAt,
      consecutiveFailures: args.consecutiveFailures,
    });
    return unchanged();
  }

  const fitted = fitCompactHistory({
    summary: macro.summary,
    tail,
    executionProfile: request.executionProfile,
    tokenLimit,
    tokensOutsideHistory,
  });
  if (!fitted) {
    recordFailure({
      request,
      compactId,
      beforeTokens,
      detail: `摘要与近期历史无法放入 ${tokenLimit} Token 的历史预算`,
      startedAt,
      consecutiveFailures: args.consecutiveFailures,
    });
    return unchanged();
  }

  args.consecutiveFailures.delete(request.sessionId);
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
    kind: 'macro',
    history: fitted.history,
    summary: fitted.summary,
    compactedMessageCount: safeCut,
  };
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
  let cut = findSafeCutPoint(args.messages, args.desiredCut);
  while (cut < args.messages.length) {
    const tail = args.messages.slice(cut);
    const tailTokens = args.tokensOutsideHistory + estimateMessagesTokens([...tail]);
    if (tailTokens + MIN_SUMMARY_BUDGET_TOKENS < args.tokenLimit) return cut;
    cut = findSafeCutPointAtOrAfter(args.messages, cut + 1);
  }
  return args.messages.length;
}

function recordFailure(args: {
  readonly request: CompactRequest;
  readonly compactId: string;
  readonly beforeTokens: number;
  readonly detail: string;
  readonly startedAt: number;
  readonly consecutiveFailures: Map<string, number>;
}): void {
  args.consecutiveFailures.set(
    args.request.sessionId,
    failureCount(args.consecutiveFailures, args.request.sessionId) + 1,
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
}

function failureCount(
  failures: ReadonlyMap<string, number>,
  sessionId: string,
): number {
  return failures.get(sessionId) ?? 0;
}

function validateRequest(request: CompactRequest): void {
  if (!Number.isFinite(request.estimatedInputTokens) || request.estimatedInputTokens < 0) {
    throw new RangeError('estimatedInputTokens 必须是非负有限数值');
  }
  if (!Number.isFinite(request.contextWindow) || request.contextWindow <= 0) {
    throw new RangeError('contextWindow 必须是正有限数值');
  }
  if (
    request.maxOutputTokens !== undefined
    && (!Number.isFinite(request.maxOutputTokens) || request.maxOutputTokens < 0)
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

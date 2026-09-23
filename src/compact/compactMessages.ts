// 判断压缩时机, 先尝试 Micro, 再调用 Macro 并保存最终摘要.

import { randomUUID } from 'node:crypto';
import type { CallLlm, Message } from '@ema-agent/llm';
import { estimateMessagesTokens } from '@ema-agent/token';
import { compactTokenLimit } from './budget.js';
import { runMacroCompact } from './macroCompact.js';
import { microCompact } from './microCompact.js';
import {
  DEFAULT_COMPACT_SETTINGS,
  type CompactSettings,
} from './settings.js';
import type {
  CompactRequest,
  CompactResult,
} from './types.js';

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
  const messages = [...request.messages];
  const unchanged = (): CompactResult => ({ kind: 'unchanged', messages });
  const fixedRequestTokens = request.estimatedInputTokens - estimateMessagesTokens(messages);
  const estimate = (candidate: readonly Message[]): number =>
    fixedRequestTokens + estimateMessagesTokens([...candidate]);
  const beforeTokens = request.estimatedInputTokens;

  if (messages.length === 0) return unchanged();

  const tokenLimit = compactTokenLimit(request.contextWindow, settings);

  if (!request.force && beforeTokens <= tokenLimit) return unchanged();
  if (
    !request.force
    && failureCount(args.consecutiveFailures, request.sessionId)
      >= settings.maximumConsecutiveFailures
  ) {
    return unchanged();
  }

  const compactId = request.compactId ?? randomUUID();
  const microMessages = request.micro === false
    ? messages
    : microCompact(messages, { keepRecentToolResults: settings.keepRecentToolResults });
  // Micro 只改消息内容, System Prompt 和 Tool 定义的 token 开销保持不变.
  const microEstimatedInputTokens = estimate(microMessages);
  if (
    !request.force
    && request.micro !== false
    && microEstimatedInputTokens <= tokenLimit
  ) {
    args.consecutiveFailures.delete(request.sessionId);
    return { kind: 'micro', messages: microMessages };
  }

  request.emit?.({
    type: 'compact_started',
    compactId,
    sessionId: request.sessionId,
    beforeTokens,
    startedAt,
  });

  let macro: Awaited<ReturnType<typeof runMacroCompact>>;
  try {
    macro = await runMacroCompact({
      callLlm: args.callLlm,
      sessionMode: request.sessionMode,
      systemMessages: request.systemMessages,
      tools: request.tools,
      ...(request.thinking ? { thinking: request.thinking } : {}),
      messages: microMessages,
      estimatedInputTokens: microEstimatedInputTokens,
      settings,
      modelContextWindow: request.contextWindow,
      modelMaxOutput: request.modelMaxOutput,
      signal: request.signal,
    });
  } catch (error) {
    if (!isAbort(error, request.signal)) throw error;
    request.emit?.({
      type: 'compact_cancelled',
      compactId,
      sessionId: request.sessionId,
      beforeTokens,
      startedAt,
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
    return { kind: 'unchanged', messages, failureDetail: macro.detail };
  }

  // 只有最终摘要保存成功才发 completed, 中间分段摘要不改变调用方消息.
  if (request.saveMacroSummary) {
    try {
      request.saveMacroSummary(macro.summary, macro.summarizedMessageCount);
    } catch (error) {
      request.emit?.({
        type: 'compact_failed',
        compactId,
        sessionId: request.sessionId,
        beforeTokens,
        startedAt,
        afterTokens: macro.afterTokens,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  const durationMs = Date.now() - startedAt;
  args.consecutiveFailures.delete(request.sessionId);
  request.emit?.({
    type: 'compact_completed',
    compactId,
    sessionId: request.sessionId,
    beforeTokens,
    startedAt,
    afterTokens: macro.afterTokens,
    savedTokens: Math.max(0, beforeTokens - macro.afterTokens),
    durationMs,
  });
  return {
    kind: 'macro',
    messages: macro.messages,
    beforeTokens,
    afterTokens: macro.afterTokens,
    savedTokens: Math.max(0, beforeTokens - macro.afterTokens),
    durationMs,
    usage: macro.usage,
    summarizedMessageCount: macro.summarizedMessageCount,
  };
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
    startedAt: args.startedAt,
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
  if (request.estimatedInputTokens < estimateMessagesTokens([...request.messages])) {
    throw new RangeError('estimatedInputTokens 不得小于 messages 本身的估算');
  }
  if (request.messages.some((message) => message.role === 'system')) {
    throw new TypeError('CompactRequest.messages 不能包含 System Prompt');
  }
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

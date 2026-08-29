// 唯一压缩管线：阈值判断、可选 Micro、调 Macro、Session 级失败熔断与持久化闭包。
// 切割（窗口截断/近期保留/候选收缩/预算拟合）全部归 macroCompact，本文件不碰。

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
  const tokensOutsideHistory = Math.max(
    0,
    request.estimatedInputTokens - estimateMessagesTokens(history),
  );
  const estimate = (candidate: readonly Message[]): number => Math.max(
    0,
    tokensOutsideHistory + estimateMessagesTokens([...candidate]),
  );
  const beforeTokens = request.estimatedInputTokens;

  if (history.length === 0) return unchanged();

  const tokenLimit = compactTokenLimit(request.contextWindow, settings);

  if (!request.force && beforeTokens <= tokenLimit) return unchanged();
  if (
    !request.force
    && failureCount(args.consecutiveFailures, request.sessionId)
      >= settings.maximumConsecutiveFailures
  ) {
    return unchanged();
  }

  const compactId = randomUUID();
  // Micro：大 ToolResult 占位替换（请求级开关；手动 /compact 关闭——替换从不落库，
  // 命令路径只要纯粹的 Macro 摘要）。
  const working = request.micro === false
    ? history
    : microCompact(history, { keepRecent: settings.keepRecentToolResults });
  // Micro 的节省属于历史内部重算：传给 Macro 的估算 = 不变的历史外成本 + Micro 后历史，
  // 否则 Macro 会把 Micro 省下的部分误算成历史外成本，直接判成"外部成本超线"。
  const workingEstimatedInputTokens = tokensOutsideHistory + estimateMessagesTokens(working);
  if (
    !request.force
    && request.micro !== false
    && estimate(working) <= tokenLimit
  ) {
    args.consecutiveFailures.delete(request.sessionId);
    return { kind: 'micro', history: working };
  }

  request.emit?.({
    type: 'compact_started',
    compactId,
    sessionId: request.sessionId,
    beforeTokens,
  });

  let macro: Awaited<ReturnType<typeof runMacroCompact>>;
  try {
    macro = await runMacroCompact({
      callLlm: args.callLlm,
      executionProfile: request.executionProfile,
      systemMessages: request.systemMessages,
      tools: request.tools,
      ...(request.thinking ? { thinking: request.thinking } : {}),
      toCompact: working,
      estimatedInputTokens: workingEstimatedInputTokens,
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
    return { kind: 'unchanged', history, failureDetail: macro.detail };
  }

  // Macro 摘要持久化在完成事件之前：只有保存成功才发后续事件，保证
  // "完成" = 摘要已落库（根 Turn / /compact）或内存替换已应用（子 Agent 不提供闭包）。
  // 截断事件也在落库之后：保存失败时历史未变，前端不得先看到"历史已经截断"。
  if (request.saveMacroSummary) {
    try {
      request.saveMacroSummary(macro.summary, macro.summarizedMessageCount);
    } catch (error) {
      request.emit?.({
        type: 'compact_failed',
        compactId,
        sessionId: request.sessionId,
        beforeTokens,
        afterTokens: macro.afterTokens,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  if (macro.droppedMessageCount > 0) {
    request.emit?.({
      type: 'compact_history_truncated',
      compactId,
      sessionId: request.sessionId,
      beforeTokens,
      droppedMessageCount: macro.droppedMessageCount,
      droppedTokens: macro.droppedTokens,
    });
  }

  const durationMs = Date.now() - startedAt;
  args.consecutiveFailures.delete(request.sessionId);
  request.emit?.({
    type: 'compact_completed',
    compactId,
    sessionId: request.sessionId,

    beforeTokens,
    afterTokens: macro.afterTokens,
    savedTokens: Math.max(0, beforeTokens - macro.afterTokens),
    durationMs,
  });
  return {
    kind: 'macro',
    history: macro.history,
    beforeTokens,
    afterTokens: macro.afterTokens,
    savedTokens: Math.max(0, beforeTokens - macro.afterTokens),
    durationMs,
    usage: macro.usage,
    // 计数相对输入历史（含被淘汰偏移），调用方游标映射无需感知偏移。
    summarizedMessageCount: macro.summarizedMessageCount,
    droppedMessageCount: macro.droppedMessageCount,
    droppedTokens: macro.droppedTokens,
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
  // 估算器同一个，全量不可能小于部分；小了就是调用方传错，静默 clamp 会吞掉这个 bug。
  if (request.estimatedInputTokens < estimateMessagesTokens([...request.history])) {
    throw new RangeError('estimatedInputTokens 不得小于 history 本身的估算（历史外成本不能为负）');
  }
  if (request.history.some((message) => message.role === 'system')) {
    throw new TypeError('CompactRequest.history 不能包含 System Prompt');
  }
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

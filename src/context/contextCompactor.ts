// 统一编排 Context 的微压缩、全量摘要、恢复、持久化和失败熔断。
import { randomUUID } from 'node:crypto';
import { asCompactionId, type MessageBlocks, type SessionId } from '@ema-agent/contracts';
import { estimateLlmInputTokens } from '@ema-agent/token';
import { fitCompactionContext } from './compaction/budget.js';
import { runMacroCompaction } from './compaction/macroCompaction.js';
import { microCompact } from './compaction/microCompaction.js';
import { buildPostCompactionRestore } from './compaction/postCompactionRestore.js';
import { findSafeCutPoint, macroFailureReason } from './compaction/safeCut.js';
import { sanitizeCompactionMessages } from './compaction/sanitize.js';
import {
  DEFAULT_CONTEXT_COMPACTION_SETTINGS,
  type ContextCompactionArgs,
  type ContextCompactionResult,
  type ContextCompactionSettings,
  type ContextCompactorDeps,
} from './compaction/types.js';

export class ContextCompactor {
  private readonly settings: ContextCompactionSettings;
  private readonly consecutiveFailures = new Map<SessionId, number>();

  constructor(
    private readonly deps: ContextCompactorDeps,
    overrides: Partial<ContextCompactionSettings> = {},
  ) {
    this.settings = { ...DEFAULT_CONTEXT_COMPACTION_SETTINGS, ...overrides };
  }

  async compact(args: ContextCompactionArgs): Promise<ContextCompactionResult> {
    const startedAt = Date.now();
    const rawPrefix = sanitizeCompactionMessages([...(args.prefixMessages ?? [])]);
    const rawHistory = sanitizeCompactionMessages(args.messages);
    const rawSuffix = sanitizeCompactionMessages([...(args.suffixMessages ?? [])]);
    const systemPrefix: ContextCompactionResult['messages'] = [
      ...rawPrefix,
      ...rawHistory,
      ...rawSuffix,
    ].filter((message) => message.role === 'system');
    const fixedPrefix = rawPrefix.filter((message) => message.role !== 'system');
    const fixedSuffix = rawSuffix.filter((message) => message.role !== 'system');
    const history: ContextCompactionResult['messages'] = rawHistory
      .filter((message) => message.role !== 'system');
    const prefix = [...systemPrefix, ...fixedPrefix];
    const assemble = (
      candidate: ContextCompactionResult['messages'],
    ): ContextCompactionResult['messages'] => [
      ...prefix,
      ...candidate,
      ...fixedSuffix,
    ];
    const estimate = (candidate: typeof history): number =>
      estimateLlmInputTokens(assemble(candidate), { tools: args.tools }).totalTokens;
    const beforeTokens = estimate(history);
    const messages = assemble(history);

    if (!this.settings.enabled) {
      return unchanged('disabled', messages, beforeTokens);
    }
    if (this.deps.isEnabledForSession?.(args.sessionId) === false) {
      return unchanged('session_disabled', messages, beforeTokens);
    }

    const reservedOutput = Math.min(
      args.modelMaxOutputTokens ?? this.settings.defaultReservedOutputTokens,
      this.settings.maximumReservedOutputTokens,
    );
    const tokenLimit = Math.max(
      1,
      args.modelContextWindow - reservedOutput - this.settings.bufferTokens,
    );

    // 活跃对话未接近阈值时保持历史字节稳定，避免无意义地破坏 KV Cache。
    if (!args.force && beforeTokens <= tokenLimit) {
      return unchanged('below_threshold', messages, beforeTokens);
    }

    if (this.failureCount(args.sessionId) >= this.settings.maximumConsecutiveFailures) {
      return skipped(
        'circuit_open',
        '连续压缩失败次数已达上限，本 Session 不再自动调用压缩模型',
        messages,
        beforeTokens,
      );
    }

    // System Prompt 是不可压缩指令，不得进入 Tool 清理或摘要模型。
    const micro = microCompact(history, { keepRecent: this.settings.keepRecentToolResults });
    let working = micro.messages;
    let estimated = estimate(working);
    if (!args.force && estimated <= tokenLimit) {
      return {
        ...unchanged('below_threshold', assemble(working), beforeTokens),
        microCleared: micro.cleared,
        afterTokens: estimated,
        savedTokens: Math.max(0, beforeTokens - estimated),
      };
    }

    const tailSize = Math.max(8, Math.ceil(working.length * 0.25));
    if (working.length <= tailSize) {
      return {
        ...unchanged('insufficient_history', assemble(working), beforeTokens),
        microCleared: micro.cleared,
        afterTokens: estimated,
        savedTokens: Math.max(0, beforeTokens - estimated),
      };
    }

    const safeCut = findSafeCutPoint(working, working.length - tailSize);
    if (safeCut === 0) {
      return {
        ...skipped('no_safe_cut', undefined, assemble(working), beforeTokens),
        microCleared: micro.cleared,
        afterTokens: estimated,
        savedTokens: Math.max(0, beforeTokens - estimated),
      };
    }

    const head = working.slice(0, safeCut);
    const tail = working.slice(safeCut);
    const compactionId = asCompactionId(randomUUID());
    const beforeHook = await this.deps.hookBus?.trigger('beforeCompact', {
      payload: { compactionId, messageCount: messages.length, tokenEstimate: estimated },
      turnId: args.turnId,
      sessionId: args.sessionId,
      signal: args.signal,
      emit: args.emit,
    });

    if (beforeHook?.kind === 'abort') {
      args.emit?.({
        type: 'context_compaction_skipped',
        compactionId,
        sessionId: args.sessionId,
        turnId: args.turnId,
        mode: args.mode,
        reason: 'hook_aborted',
        message: beforeHook.reason,
        beforeTokens,
        afterTokens: estimated,
        durationMs: Date.now() - startedAt,
      });
      return {
        ...skipped('hook_aborted', beforeHook.reason, assemble(working), beforeTokens),
        microCleared: micro.cleared,
        afterTokens: estimated,
        savedTokens: Math.max(0, beforeTokens - estimated),
      };
    }

    args.emit?.({
      type: 'context_compaction_started',
      compactionId,
      sessionId: args.sessionId,
      turnId: args.turnId,
      mode: args.mode,
      beforeTokens,
    });

    const macro = await runMacroCompaction({
      llm: this.deps.llm,
      providerId: args.providerId,
      model: args.model,
      mode: args.mode,
      toCompact: head,
      modelContextWindow: args.modelContextWindow,
      signal: args.signal,
    });

    if (!macro.succeeded || !macro.summary) {
      return this.fail(args, compactionId, assemble(working), micro.cleared, beforeTokens, estimated,
        macroFailureReason(macro.attempts), startedAt);
    }

    const restore = buildPostCompactionRestore(this.deps.loadSessionNote, {
      sessionId: args.sessionId,
      mode: args.mode,
      recentFiles: args.recentFiles,
    });
    const toolTokens = estimateLlmInputTokens([], { tools: args.tools }).totalTokens;
    const fitted = fitCompactionContext({
      summary: macro.summary,
      prefix,
      suffix: fixedSuffix,
      restore,
      tail,
      mode: args.mode,
      tokenLimit,
      fixedTokens: toolTokens,
    });
    if (!fitted) {
      return this.fail(
        args,
        compactionId,
        assemble(working),
        micro.cleared,
        beforeTokens,
        estimated,
        `压缩后的上下文仍超过硬限制 ${tokenLimit}`,
        startedAt,
      );
    }

    this.deps.persistSummary({
      turnId: args.turnId,
      sessionId: args.sessionId,
      role: 'user',
      kind: 'summary',
      blocks: fitted.summary satisfies MessageBlocks,
    });
    working = fitted.messages;
    const afterTokens = fitted.afterTokens;
    this.consecutiveFailures.delete(args.sessionId);

    args.emit?.({
      type: 'context_compaction_completed',
      compactionId,
      sessionId: args.sessionId,
      turnId: args.turnId,
      mode: args.mode,
      beforeTokens,
      afterTokens,
      savedTokens: Math.max(0, beforeTokens - afterTokens),
      durationMs: Date.now() - startedAt,
    });
    await this.deps.hookBus?.trigger('afterCompact', {
      payload: { compactionId, before: beforeTokens, after: afterTokens, method: 'macro' },
      turnId: args.turnId,
      sessionId: args.sessionId,
      signal: args.signal,
      emit: args.emit,
    });

    return {
      status: 'completed',
      messages: working,
      macroRan: true,
      microCleared: micro.cleared,
      beforeTokens,
      afterTokens,
      savedTokens: Math.max(0, beforeTokens - afterTokens),
    };
  }

  private failureCount(sessionId: SessionId): number {
    return this.consecutiveFailures.get(sessionId) ?? 0;
  }

  private fail(
    args: ContextCompactionArgs,
    compactionId: ReturnType<typeof asCompactionId>,
    messages: ContextCompactionResult['messages'],
    microCleared: number,
    beforeTokens: number,
    afterTokens: number,
    detail: string,
    startedAt: number,
  ): ContextCompactionResult {
    this.consecutiveFailures.set(args.sessionId, this.failureCount(args.sessionId) + 1);
    args.emit?.({
      type: 'context_compaction_failed',
      compactionId,
      sessionId: args.sessionId,
      turnId: args.turnId,
      mode: args.mode,
      error: detail,
      beforeTokens,
      afterTokens,
      durationMs: Date.now() - startedAt,
    });
    return {
      status: 'failed',
      reason: 'macro_failed',
      detail,
      messages,
      macroRan: false,
      microCleared,
      beforeTokens,
      afterTokens,
      savedTokens: Math.max(0, beforeTokens - afterTokens),
    };
  }
}

function unchanged(
  reason: Extract<ContextCompactionResult, { status: 'not_needed' }>['reason'],
  messages: ContextCompactionResult['messages'],
  tokenCount: number,
): Extract<ContextCompactionResult, { status: 'not_needed' }> {
  return {
    status: 'not_needed',
    reason,
    messages,
    macroRan: false,
    microCleared: 0,
    beforeTokens: tokenCount,
    afterTokens: tokenCount,
    savedTokens: 0,
  };
}

function skipped(
  reason: Extract<ContextCompactionResult, { status: 'skipped' }>['reason'],
  detail: string | undefined,
  messages: ContextCompactionResult['messages'],
  tokenCount: number,
): Extract<ContextCompactionResult, { status: 'skipped' }> {
  return {
    status: 'skipped',
    reason,
    detail,
    messages,
    macroRan: false,
    microCleared: 0,
    beforeTokens: tokenCount,
    afterTokens: tokenCount,
    savedTokens: 0,
  };
}

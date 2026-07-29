// 统一编排 Context 的微压缩、全量摘要、恢复、持久化和失败熔断。
import { randomUUID } from 'node:crypto';
import { asCompactionId, type SessionId } from '@ema-agent/ids';
import type { MessageBlocks } from '@ema-agent/session';
import { estimateLlmInputTokens } from '@ema-agent/token';
import { fitCompactionContext } from './compaction/budget.js';
import { runMacroCompaction } from './compaction/macroCompaction.js';
import { microCompact } from './compaction/microCompaction.js';
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
    const settings = args.settings ?? this.settings;
    const startedAt = Date.now();
    const rawPrefix = sanitizeCompactionMessages([...(args.prefixMessages ?? [])]);
    const rawHistory = sanitizeCompactionMessages(args.messages);
    const rawSuffix = sanitizeCompactionMessages([...(args.suffixMessages ?? [])]);
    // system 消息是不可压缩指令,统一抽到 prefix 头部,不进摘要模型,也不参与 Tool 清理。
    // 压缩只作用于 history 的非 system 部分。
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
    // assemble / estimate 闭包:后续每一步都能复用同一套拼装 + 估算逻辑,避免散落多份。
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

    if (!settings.enabled) {
      return unchanged('disabled', messages, beforeTokens);
    }
    if (this.deps.isEnabledForSession?.(args.sessionId) === false) {
      return unchanged('session_disabled', messages, beforeTokens);
    }

    const reservedOutput = Math.min(
      args.modelMaxOutputTokens ?? settings.defaultReservedOutputTokens,
      settings.maximumReservedOutputTokens,
    );
    const tokenLimit = Math.max(
      1,
      args.modelContextWindow - reservedOutput - settings.bufferTokens,
    );

    // 活跃对话未接近阈值时保持历史字节稳定，避免无意义地破坏 KV Cache。
    // force=true 时跳过该判断(如上下文已溢出,必须压缩)。
    if (!args.force && beforeTokens <= tokenLimit) {
      return unchanged('below_threshold', messages, beforeTokens);
    }

    // 熔断:该 Session 连续压缩失败达上限,不再自动调压缩模型,避免反复浪费 LLM 调用。
    // 成功一次即清零(见 compact 末尾 consecutiveFailures.delete)。
    if (this.failureCount(args.sessionId) >= settings.maximumConsecutiveFailures) {
      return skipped(
        'circuit_open',
        '连续压缩失败次数已达上限，本 Session 不再自动调用压缩模型',
        messages,
        beforeTokens,
      );
    }

    // 第 1 级:Micro 压缩。只清理旧 Tool Result(保留最近 N 条),不调 LLM。
    // 够小就返回,省一次 LLM 调用。
    const micro = microCompact(history, { keepRecent: settings.keepRecentToolResults });
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

    // 第 2 级:Macro 压缩(调 LLM 摘要)。保留尾部 25%(至少 8 条)原文不摘要,
    // 因为最近消息最重要。head 才送摘要模型。
    const tailSize = Math.max(8, Math.ceil(working.length * 0.25));
    if (working.length <= tailSize) {
      return {
        ...unchanged('insufficient_history', assemble(working), beforeTokens),
        microCleared: micro.cleared,
        afterTokens: estimated,
        savedTokens: Math.max(0, beforeTokens - estimated),
      };
    }

    // 安全切割点允许 tail 从 assistant tool_use 开始，但不能从含 tool_result 的
    // user 消息开始；后者会把对应调用留在摘要 head，形成孤立结果。
    const safeCut = findSafeCutPoint(working, working.length - tailSize);
    // 只有损坏历史（例如开头就是孤立 tool_result）才可能找不到切点。此时将整段
    // 历史文本化后交给 Macro，避免 force 压缩原样返回并反复触发 PTL。
    const head = safeCut > 0 ? working.slice(0, safeCut) : working;
    const tail = safeCut > 0 ? working.slice(safeCut) : [];
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
        executionProfile: args.executionProfile,
        narrativePolicy: args.narrativePolicy,
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
      executionProfile: args.executionProfile,
      narrativePolicy: args.narrativePolicy,
      beforeTokens,
    });

    // Macro 压缩(第 2 级):调 LLM 把 head 摘要成结构化文本。
    // 失败走 fail() 熔断计数 +1;成功才继续。
    const macro = await runMacroCompaction({
      llm: this.deps.llm,
      providerId: args.providerId,
      model: args.model,
      executionProfile: args.executionProfile,
      toCompact: head,
      modelContextWindow: args.modelContextWindow,
      signal: args.signal,
    });

    if (!macro.succeeded || !macro.summary) {
      return this.fail(args, compactionId, assemble(working), micro.cleared, beforeTokens, estimated,
        macroFailureReason(macro.attempts), startedAt);
    }

    const requiredRestore = sanitizeCompactionMessages([
      ...(args.requiredRestoreMessages ?? []),
    ]);
    // 预算适配:把 [prefix, summary, requiredRestore, tail, suffix] 塞进 tokenLimit。
    // 摘要 + tail 仍超限时,fit 会进一步裁剪 tail;塞不下返回 null(失败)。
    const toolTokens = estimateLlmInputTokens([], { tools: args.tools }).totalTokens;
    const fitted = fitCompactionContext({
      summary: macro.summary,
      prefix,
      suffix: fixedSuffix,
      requiredRestore,
      tail,
      executionProfile: args.executionProfile,
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
      executionProfile: args.executionProfile,
      narrativePolicy: args.narrativePolicy,
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
      executionProfile: args.executionProfile,
      narrativePolicy: args.narrativePolicy,
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

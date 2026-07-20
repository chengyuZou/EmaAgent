// 运行一次 chat/narrative Turn，并串联 Hook、召回、LLM 流和持久化。

import { randomUUID } from 'node:crypto';
import type { EmaStreamEvent, ErrorCode } from '@ema-agent/contracts';
import { asLlmCallId, LlmModelCapabilityError, llmProviderErrorCode } from '@ema-agent/llm';
import type {
  AssistantBlock,
  LlmContentPart,
  LlmTokenUsage,
  Message as ModelMessage,
  UserBlock,
} from '@ema-agent/llm';
import type { MessageBlocks } from '@ema-agent/session';
import type { HookBus, HookTriggerContext, HookTriggerResult, TurnFailurePhase } from '@ema-agent/hook';
import type { ConversationDeps, ConversationRunInput } from './types.js';
import {
  buildModelMessages,
  computePromptPrefixHash,
  prepareHistoricalMessageView,
  validateCurrentContent,
} from '@ema-agent/context';

// ── ConversationEngine ────────────────────────────────────────────────────────

/**
 * 用一条统一流程处理 chat 和 narrative turn。
 *
 * Narrative 专属逻辑（RAG 召回）全在 registerConversationHooks() 注册的
 * `narrative:recall` beforeLlm hook 里--engine 本身没有 mode 分支。
 *
 * 与传输无关：返回 AsyncIterable<EmaStreamEvent>。
 * 由 apps/core orchestrator（SSE）和未来 CLI（stdout）消费。
 */
export class ConversationEngine {
  constructor(private readonly deps: ConversationDeps) {}

  run(input: ConversationRunInput): AsyncIterable<EmaStreamEvent> {
    return runTurn(this.deps, input);
  }
}

// ── 单条统一 turn 流程 ──────────────────────────────────────────────────────────

async function* runTurn(
  deps: ConversationDeps,
  input: ConversationRunInput,
): AsyncIterable<EmaStreamEvent> {
  const { session, hooks, llm, emotion } = deps;
  const startedAt = Date.now();
  const { turn, signal } = input;
  const turnId = turn.id;
  const mode = turn.mode;

  // Bug #2：记录 LLM 流是否正常结束，用来区分真正的用户中途 abort
  // 和流结束后的错误（那时 signal.aborted 可能恰好为 true）。
  let llmStreamDone = false;
  const pendingHookEvents: EmaStreamEvent[] = [];
  const emitHookEvent = (event: EmaStreamEvent): void => {
    pendingHookEvents.push(event);
  };
  let activePhase: TurnFailurePhase = 'setup';
  let failureReported = false;
  const reportFailure = async (
    code: ErrorCode,
    message: string,
    phase: TurnFailurePhase,
  ): Promise<void> => {
    if (failureReported) return;
    failureReported = true;
    session.failTurn(turnId, code, message);
    await hooks.trigger('onTurnFailure', {
      turnId,
      sessionId: input.sessionId,
      payload: { phase, code, message, durationMs: Date.now() - startedAt },
      emit: emitHookEvent,
    });
  };

  try {
    emotion.beginTurn(input.sessionId);

    // ── onTurnStart ───────────────────────────────────────────────────────────
    activePhase = 'hook';
    const startResult = await hooks.trigger('onTurnStart', {
      turnId,
      sessionId: input.sessionId,
      payload: { mode },
      signal,
      emit: emitHookEvent,
    });
    while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
    if (startResult.kind === 'abort') {
      await reportFailure('turn/hook_aborted', startResult.reason, 'hook');
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
      yield { type: 'turn_failed', sessionId: input.sessionId, turnId, code: 'turn/hook_aborted', message: startResult.reason };
      return;
    }

    yield { type: 'turn_started', sessionId: input.sessionId, turnId, mode };

    // ── Provider 解析 ──────────────────────────────────────────────────────────
    // 优先用 orchestrator 给的显式 (providerId, model)（前端 picker 或
    // resolveLlmForTurn）。没有就退回第一个可用 LLM provider。
    activePhase = 'provider';
    const providerId    = input.providerId ?? llm.firstProviderId();
    const resolvedModel = input.model
      ?? (providerId ? llm.defaultModelFor(providerId) : undefined);

    if (!providerId || !resolvedModel) {
      const message = 'No LLM provider configured for this mode';
      await reportFailure('provider/not_configured', message, 'provider');
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
      yield { type: 'turn_failed', sessionId: input.sessionId, turnId, code: 'provider/not_configured', message };
      return;
    }

    for (const degradation of input.requestDegradations ?? []) {
      yield {
        type: 'request_degraded',
        sessionId: input.sessionId,
        turnId,
        ...degradation,
      };
    }

    // ── 上下文 + user 消息 ──────────────────────────────────────────────────────
    activePhase = 'provider';
    const history = session.loadHistory(input.sessionId);

    // userBlocks：纯文本用 string，多模态用 LlmContentPart[]
    const userBlocks: string | LlmContentPart[] =
      input.contentParts && input.contentParts.length > 0
        ? input.contentParts
        : input.userInput;

    const capabilities = llm.capabilitiesFor(providerId, resolvedModel);
    if (Array.isArray(userBlocks)) {
      const issues = validateCurrentContent(userBlocks, capabilities);
      if (issues.length > 0) {
        throw new LlmModelCapabilityError(providerId, resolvedModel, issues);
      }
    }
    const historyView = prepareHistoricalMessageView(
      buildModelMessages(history),
      capabilities,
    );
    if (historyView.actions.length > 0) {
      yield {
        type: 'request_degraded',
        sessionId: input.sessionId,
        turnId,
        attempt: 1,
        reason: '历史消息包含当前模型不支持或能力未知的媒体，已创建只读兼容视图',
        removed: [...new Set(historyView.actions.map((action) => action.modality))],
        replacements: ['placeholder'],
      };
    }

    activePhase = 'persistence';
    session.appendMessage({
      turnId,
      sessionId: input.sessionId,
      role: 'user',
      // LlmContentPart（= MessageContentPart）是 UserBlock 的子类型，安全转型
      blocks: userBlocks as MessageBlocks,
    });

    let messages: ModelMessage[] = [
      ...historyView.messages,
      {
        role: 'user',
        content: userBlocks as string | UserBlock[],
      },
    ];

    // Conversation 当前只有一次逻辑推理，但仍使用与 Agent 完全相同的身份
    // 契约。未来 chat/narrative 升级为多轮时只需让 iteration 递增。
    const iteration = 1;
    const llmCallId = asLlmCallId(randomUUID());

    if (input.compactMessages) {
      activePhase = 'unknown';
      messages = await input.compactMessages([...messages]);
    }

    // 检查当前 provider 处理不了的附件并警告。
    // 语言模型运行时内部查协议，Engine 不需要知道 Provider 线路。
    const partsToCheck = Array.isArray(userBlocks) ? userBlocks : [];
    if (partsToCheck.length > 0) {
      const issues = llm.warnUnsupportedParts(providerId, partsToCheck);
      if (issues.length > 0) {
        yield {
          type: 'system_warning',
          level: 'warn',
          message: `${issues.length} attachment(s) not supported by the current model: ${issues.map(i => i.reason).join('; ')}`,
        };
      }
    }

    // ── beforeLlm hook（并发排空）──────────────────────────────────────────────
    // narrative:recall 并发查各 timeline，每条完成就 emit
    // `narrative_timeline_complete`。必须立即 yield 每个 emit 的事件--不能
    // 缓冲后排空--前端才能看到逐条 timeline 完成而不是一次性全到。
    //
    // 模式：把 trigger() 当后台任务跑，emit() 时就 yield，等任务结束再看结果。
    activePhase = 'hook';
    const llmHookResult = yield* streamingBeforeLlm(hooks, {
      turnId,
      sessionId: input.sessionId,
      payload: {
        iteration,
        llmCallId,
        messages,
        mode,
        userInput: input.userInput,
        providerId,
        model: resolvedModel,
      },
      signal,
    });

    if (llmHookResult.kind === 'abort') {
      await reportFailure('turn/hook_aborted', llmHookResult.reason, 'hook');
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
      yield { type: 'turn_failed', sessionId: input.sessionId, turnId, code: 'turn/hook_aborted', message: llmHookResult.reason };
      return;
    }
    // Hook 新增内容没有可靠的历史/本轮来源标记，不能在这里猜测并静默替换。
    // LLM 请求准备器会对最终组装结果执行 fail-closed 能力门禁。
    const finalMessages = llmHookResult.payload.messages;

    // ── narrative 检索结果落盘 ──────────────────────────────────────────────
    // narrative:recall hook 通过 replace payload 返回检索结果。落盘成
    // kind='narrative_context' message:既回灌 LLM(下一轮 buildModelMessages
    // 转文本)又前端显示(检索块气泡)。一份内容不拆。本轮 LLM 已通过 inject 的
    // 临时 user message 看过检索内容(上面 finalMessages 里),这里落盘是给未来轮次 + 前端展示。
    const narrativeRecall = llmHookResult.payload.narrativeRecall;
    if (narrativeRecall && narrativeRecall.timelines.length > 0) {
      activePhase = 'persistence';
      session.appendMessage({
        turnId,
        sessionId: input.sessionId,
        role: 'user',
        kind: 'narrative_context',
        blocks: { timelines: narrativeRecall.timelines },
      });
    }

    // ── LLM 流 ────────────────────────────────────────────────────────────────
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let llmUsage: LlmTokenUsage = { inputTokens: 0, outputTokens: 0 };
    let lastTextBlockIndex = 0;
    const textByIndex = new Map<number, string>();
    const thinkingByIndex = new Map<number, string>();
    const thinkingSignatureByIndex = new Map<number, string>();
    const completedThinkingIndexes = new Set<number>();

    activePhase = 'provider';
    const promptPrefixHash = computePromptPrefixHash({ messages: finalMessages });
    const stream = llm.stream({
      providerId,
      model: resolvedModel,
      messages: finalMessages,
      thinking: input.thinking,
      signal,
      usageContext: {
        callId: llmCallId,
        sessionId: input.sessionId,
        turnId,
      },
    });

    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'request_degraded':
          yield {
            type: 'request_degraded',
            sessionId: input.sessionId,
            turnId,
            attempt: chunk.attempt,
            reason: chunk.reason,
            removed: chunk.removed,
            replacements: chunk.replacements,
          };
          break;
        case 'text_delta': {
          const { cleaned, events } = emotion.processChunk(chunk.delta, turnId, input.sessionId);
          fullText += cleaned;
          lastTextBlockIndex = chunk.blockIndex;
          if (cleaned) {
            textByIndex.set(chunk.blockIndex, (textByIndex.get(chunk.blockIndex) ?? '') + cleaned);
            yield { type: 'output_text_delta', sessionId: input.sessionId, blockIndex: chunk.blockIndex, delta: cleaned };
          }
          for (const ev of events) yield ev;
          break;
        }
        case 'thinking_delta':
          thinkingByIndex.set(chunk.blockIndex, (thinkingByIndex.get(chunk.blockIndex) ?? '') + chunk.delta);
          yield { type: 'reasoning_delta', sessionId: input.sessionId, blockIndex: chunk.blockIndex, delta: chunk.delta };
          break;
        case 'thinking_complete':
          thinkingSignatureByIndex.set(chunk.blockIndex, chunk.signature);
          completedThinkingIndexes.add(chunk.blockIndex);
          yield { type: 'reasoning_complete', sessionId: input.sessionId, blockIndex: chunk.blockIndex };
          break;
        case 'usage':
          inputTokens = chunk.inputTokens;
          outputTokens = chunk.outputTokens;
          llmUsage = {
            inputTokens,
            outputTokens,
            ...(chunk.cacheReadInputTokens !== undefined
              ? { cacheReadInputTokens: chunk.cacheReadInputTokens }
              : {}),
            ...(chunk.cacheWriteInputTokens !== undefined
              ? { cacheWriteInputTokens: chunk.cacheWriteInputTokens }
              : {}),
            ...(chunk.cacheHitRate !== undefined ? { cacheHitRate: chunk.cacheHitRate } : {}),
          };
          yield { type: 'usage_update', sessionId: input.sessionId, turnId, inputTokens, outputTokens };
          break;
        case 'done':
        case 'tool_use_delta':
        case 'tool_use_complete':
          break;
      }
    }

    for (const blockIndex of thinkingByIndex.keys()) {
      if (!completedThinkingIndexes.has(blockIndex)) {
        completedThinkingIndexes.add(blockIndex);
        yield { type: 'reasoning_complete', sessionId: input.sessionId, blockIndex };
      }
    }

    // Bug #2：在任何流后工作之前标记流结束，这样 catch 块知道这里的 abort 不是流中用户停止。
    llmStreamDone = true;

    // 冲刷扫描器尾部（模型可能在标签中途停止）
    const { cleaned: tail } = emotion.flush(turnId, input.sessionId);
    if (tail) {
      fullText += tail;
      textByIndex.set(lastTextBlockIndex, (textByIndex.get(lastTextBlockIndex) ?? '') + tail);
      yield { type: 'output_text_delta', sessionId: input.sessionId, blockIndex: lastTextBlockIndex, delta: tail };
    }

    // ── 流后 hook + 落盘 ───────────────────────────────────────────────────────
    activePhase = 'hook';
    await hooks.trigger('afterLlmComplete', {
      turnId,
      sessionId: input.sessionId,
      payload: {
        iteration,
        llmCallId,
        content: fullText,
        usage: llmUsage,
        promptPrefixHash,
      },
      signal,
      emit: emitHookEvent,
    });
    while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;

    activePhase = 'persistence';
    const assistantBlocks = buildAssistantBlocks(
      textByIndex,
      thinkingByIndex,
      thinkingSignatureByIndex,
      fullText,
    );
    const msg = session.appendMessage({
      turnId,
      sessionId: input.sessionId,
      role: 'assistant',
      // 持久化可见文本和 provider reasoning，供 UI/调试历史。
      // 下一轮 LLM 调用的回灌由 buildModelMessages() 处理，它故意过滤掉
      // thinking/tool block 以保 provider 安全。
      blocks: assistantBlocks as MessageBlocks,
    });

    activePhase = 'hook';
    await hooks.trigger('afterAssistantMessage', {
      turnId,
      sessionId: input.sessionId,
      payload: { messageId: msg.id, blocks: assistantBlocks },
      signal,
      emit: emitHookEvent,
    });
    while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;

    const durationMs = Date.now() - startedAt;
    await hooks.trigger('onTurnEnd', {
      turnId,
      sessionId: input.sessionId,
      payload: { durationMs },
      signal,
      emit: emitHookEvent,
    });
    while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;

    activePhase = 'persistence';
    session.completeTurn(turnId, { usageInputTokens: inputTokens, usageOutputTokens: outputTokens });
    yield { type: 'turn_completed', sessionId: input.sessionId, turnId, stats: { inputTokens, outputTokens, durationMs } };

  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);

    // Bug #2：只有 LLM 流还在进行时才当用户 abort。
    // 流后错误（hook 失败、落盘失败）即使 signal 恰好 aborted 也走 failTurn。
    if (signal.aborted && !llmStreamDone) {
      await hooks.trigger('onTurnAbort', {
        turnId,
        sessionId: input.sessionId,
        payload: { reason: 'user_stop' },
        emit: emitHookEvent,
      });
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
      session.abortTurn(input.sessionId, turnId);
      yield { type: 'turn_aborted', sessionId: input.sessionId, turnId, reason: 'user_stop' };
    } else {
      const code: ErrorCode = activePhase === 'provider'
        ? llmProviderErrorCode(err)
        : 'turn/execution_failed';
      await reportFailure(code, reason, activePhase);
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
      yield { type: 'turn_failed', sessionId: input.sessionId, turnId, code, message: reason };
    }
  }
}

// ── streamingBeforeLlm ────────────────────────────────────────────────────────

/**
 * 把 beforeLlm hook 链当后台任务跑，emit 的 SSE 事件一到就立即 yield--
 * 不是等整条链结束才 yield。
 *
 * 这是逐条 timeline 渐进渲染的基础：narrative:recall hook 每条 queryOne()
 * 完成就 emit `narrative_timeline_complete`，本函数把它直接转发到 SSE 流，
 * 不等慢的 timeline。
 *
 * 用法：  const result = yield* streamingBeforeLlm(hooks, ctx);
 * `yield*` 把 emit 的事件传给外层 generator，并把 HookTriggerResult 作为表达式值。
 */
async function* streamingBeforeLlm(
  hooks: HookBus,
  ctx: Omit<HookTriggerContext<'beforeLlm'>, 'emit'>,
): AsyncGenerator<EmaStreamEvent, HookTriggerResult<'beforeLlm'>> {
  const queue: EmaStreamEvent[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let result!: HookTriggerResult<'beforeLlm'>;
  let error: unknown;

  const emit = (ev: EmaStreamEvent) => {
    queue.push(ev);
    notify?.();
    notify = null;
  };

  hooks.trigger('beforeLlm', { ...ctx, emit }).then(
    (r) => { result = r; done = true; notify?.(); notify = null; },
    (e: unknown) => { error = e; done = true; notify?.(); notify = null; },
  );

  while (!done || queue.length > 0) {
    while (queue.length > 0) yield queue.shift()!;
    if (!done) await new Promise<void>((r) => { notify = r; });
  }

  if (error !== undefined) throw error as Error;
  return result;
}

// ── Session history → ModelMessage 投影 ─────────────────────────────────────────

function buildAssistantBlocks(
  textByIndex: Map<number, string>,
  thinkingByIndex: Map<number, string>,
  thinkingSignatureByIndex: Map<number, string>,
  fallbackText: string,
): AssistantBlock[] {
  const blockEntries: Array<[number, AssistantBlock]> = [];

  for (const [idx, text] of textByIndex) {
    if (text.length > 0) blockEntries.push([idx, { type: 'text', text }]);
  }

  for (const [idx, thinking] of thinkingByIndex) {
    if (thinking.length === 0) continue;
    const signature = thinkingSignatureByIndex.get(idx);
    blockEntries.push([
      idx,
      { type: 'thinking', thinking, ...(signature ? { signature } : {}) },
    ]);
  }

  blockEntries.sort((a, b) => a[0] - b[0]);

  if (blockEntries.length === 0) {
    return [{ type: 'text', text: fallbackText }];
  }

  return blockEntries.map(([, block]) => block);
}

// buildModelMessages 与 AgentEngine 共享，定义在 @ema-agent/context。

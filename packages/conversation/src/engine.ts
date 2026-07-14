import { randomUUID } from 'node:crypto';
import { asLlmCallId } from '@ema-agent/contracts';
import type { EmaStreamEvent, ErrorCode, LlmMessage, AssistantBlock, UserBlock, MessageContentPart as LlmContentPart } from '@ema-agent/contracts';
import type { LlmUsage } from '@ema-agent/contracts';
import { computePromptPrefixHash, llmProviderErrorCode } from '@ema-agent/llm';
import type { MessageBlocks } from '@ema-agent/session';
import type { HookBus, HookTriggerContext, HookTriggerResult, TurnFailurePhase } from '@ema-agent/hook';
import type { ConversationDeps, ConversationRunInput } from './types.js';
import { historyToLlmMessages } from '@ema-agent/session';

// ── ConversationEngine ────────────────────────────────────────────────────────

/**
 * Handles chat and narrative turns via a single unified flow.
 *
 * Narrative-specific logic (RAG recall) lives entirely in the `narrative:recall`
 * beforeLlm hook registered by registerConversationHooks() — the engine itself
 * has zero mode branching.
 *
 * Transport-agnostic: returns AsyncIterable<EmaStreamEvent>.
 * Consumed by apps/core orchestrator (SSE) and future CLI (stdout).
 */
export class ConversationEngine {
  constructor(private readonly deps: ConversationDeps) {}

  run(input: ConversationRunInput): AsyncIterable<EmaStreamEvent> {
    return runTurn(this.deps, input);
  }
}

// ── Single unified turn flow ──────────────────────────────────────────────────

async function* runTurn(
  deps: ConversationDeps,
  input: ConversationRunInput,
): AsyncIterable<EmaStreamEvent> {
  const { session, hooks, llm, emotion } = deps;
  const startedAt = Date.now();
  const { turn, signal } = input;
  const turnId = turn.id;
  const mode = turn.mode;

  // Bug #2: track whether the LLM stream finished normally so we can
  // distinguish a genuine user abort (mid-stream) from a post-stream error
  // where signal.aborted might coincidentally be true.
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

    // ── Provider resolution ──────────────────────────────────────────────────
    // Prefer explicit (providerId, model) from the orchestrator (frontend picker
    // or resolveLlmForTurn). Falls back to the first available LLM provider.
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

    // ── Context + user message ────────────────────────────────────────────────
    activePhase = 'provider';
    const history = session.loadHistory(input.sessionId);

    // userBlocks: plain string for text-only, or LlmContentPart[] for multimodal
    const userBlocks: string | LlmContentPart[] =
      input.contentParts && input.contentParts.length > 0
        ? input.contentParts
        : input.userInput;

    if (Array.isArray(userBlocks)) {
      llm.assertCurrentContentCompatible(providerId, resolvedModel, userBlocks);
    }
    const historyView = llm.prepareHistoricalMessages(
      providerId,
      resolvedModel,
      historyToLlmMessages(history),
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
      // LlmContentPart (= MessageContentPart) is a subtype of UserBlock — safe cast
      blocks: userBlocks as MessageBlocks,
    });

    let messages: LlmMessage[] = [
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

    // Warn about attachments the resolved provider can't handle.
    // LlmRouter looks up the protocol internally — engine never needs to know it.
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

    // ── beforeLlm hook (concurrent drain) ────────────────────────────────────
    // narrative:recall fires per-timeline queries in parallel and emits
    // `narrative_timeline_complete` as each one finishes. We must yield each
    // emitted event immediately — not buffer-then-drain — so the frontend sees
    // progressive timeline completion instead of all results at once.
    //
    // Pattern: run trigger() as a background task, yield events as emit() is
    // called, wait for the task to finish, then inspect the result.
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
    // Router 会对最终组装结果执行 fail-closed 能力门禁。
    const finalMessages = llmHookResult.payload.messages;

    // ── narrative 检索结果落盘 ──────────────────────────────────────────────
    // narrative:recall hook 通过 replace payload 返回检索结果。落盘成
    // kind='narrative_context' message:既回灌 LLM(下一轮 historyToLlmMessages
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

    // ── LLM stream ────────────────────────────────────────────────────────────
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let llmUsage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    let lastTextBlockIndex = 0;
    const textByIndex = new Map<number, string>();
    const thinkingByIndex = new Map<number, string>();
    const thinkingSignatureByIndex = new Map<number, string>();
    const completedThinkingIndexes = new Set<number>();

    activePhase = 'provider';
    const promptPrefixHash = computePromptPrefixHash({ messages: finalMessages });
    const stream = llm.stream({ providerId, model: resolvedModel, messages: finalMessages, thinking: input.thinking, signal });

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

    // Bug #2: mark stream done before any post-stream work so the catch block
    // knows an abort here is not a mid-stream user stop.
    llmStreamDone = true;

    // Flush scanner tail (model may have stopped mid-tag)
    const { cleaned: tail } = emotion.flush(turnId, input.sessionId);
    if (tail) {
      fullText += tail;
      textByIndex.set(lastTextBlockIndex, (textByIndex.get(lastTextBlockIndex) ?? '') + tail);
      yield { type: 'output_text_delta', sessionId: input.sessionId, blockIndex: lastTextBlockIndex, delta: tail };
    }

    // ── Post-stream hooks + persist ───────────────────────────────────────────
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
      // Persist visible text and provider reasoning for UI/debug history.
      // Replay to the next LLM call is handled by historyToLlmMessages(), which
      // deliberately filters thinking/tool blocks out for provider safety.
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

    // Bug #2: only treat as user abort if the LLM stream was still in progress.
    // A post-stream error (hook failure, persist error) goes to failTurn even if
    // signal happens to be aborted.
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
 * Run the beforeLlm hook chain as a background task and yield emitted SSE
 * events immediately as they arrive — not after the whole chain finishes.
 *
 * This is what enables per-timeline progressive rendering: the narrative:recall
 * hook emits `narrative_timeline_complete` as each queryOne() resolves, and
 * this function forwards each one to the SSE stream without waiting for the
 * slower timelines to finish.
 *
 * Usage:  const result = yield* streamingBeforeLlm(hooks, ctx);
 * `yield*` propagates emitted events to the outer generator and captures the
 * HookTriggerResult as the expression value.
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

// ── History → LlmMessage conversion ──────────────────────────────────────────

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

// historyToLlmMessages is shared with AgentEngine — defined in @ema-agent/session.

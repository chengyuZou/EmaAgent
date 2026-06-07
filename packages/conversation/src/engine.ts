import type { EmaStreamEvent, LlmMessage, AssistantBlock, UserBlock, MessageContentPart as LlmContentPart } from '@ema-agent/contracts';
import type { MessageBlocks } from '@ema-agent/session';
import type { HookBus, HookContext, HookTriggerResult } from '@ema-agent/hook';
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

  try {
    emotion.beginTurn(input.sessionId);

    // ── onTurnStart ───────────────────────────────────────────────────────────
    const startResult = await hooks.trigger('onTurnStart', {
      turnId,
      sessionId: input.sessionId,
      payload: { mode },
      meta: {},
    });
    if (startResult.kind === 'abort') {
      session.failTurn(turnId, 'turn/hook_aborted', startResult.reason);
      yield { type: 'turn_failed', turnId, code: 'turn/hook_aborted', message: startResult.reason };
      return;
    }

    yield { type: 'turn_started', turnId, mode };

    // ── Provider resolution (early — needed for content-part validation) ─────
    const binding = deps.modelBindings.get(mode as 'chat' | 'narrative');
    const providerId = binding?.providerConfigId ?? llm.firstProviderId();
    const resolvedModel = input.model
      ?? binding?.model
      ?? (providerId ? llm.defaultModelFor(providerId) : undefined);

    if (!providerId || !resolvedModel) {
      session.failTurn(turnId, 'provider/not_configured', 'No LLM provider configured for this mode');
      yield { type: 'turn_failed', turnId, code: 'provider/not_configured', message: 'No LLM provider configured for this mode' };
      return;
    }

    // ── Context + user message ────────────────────────────────────────────────
    const history = session.loadHistory(input.sessionId);

    // userBlocks: plain string for text-only, or LlmContentPart[] for multimodal
    const userBlocks: string | LlmContentPart[] =
      input.contentParts && input.contentParts.length > 0
        ? input.contentParts
        : input.userInput;

    session.appendMessage({
      turnId,
      sessionId: input.sessionId,
      role: 'user',
      // LlmContentPart (= MessageContentPart) is a subtype of UserBlock — safe cast
      blocks: userBlocks as MessageBlocks,
    });

    const messages: LlmMessage[] = [
      ...historyToLlmMessages(history),
      {
        role: 'user',
        content: userBlocks as string | UserBlock[],
      },
    ];

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
    const llmHookResult = yield* streamingBeforeLlm(hooks, {
      turnId,
      sessionId: input.sessionId,
      payload: { systemPrompt: '', messages },
      meta: { mode, userInput: input.userInput, signal, providerId, model: resolvedModel },
    });

    if (llmHookResult.kind === 'abort') {
      session.failTurn(turnId, 'turn/hook_aborted', llmHookResult.reason);
      yield { type: 'turn_failed', turnId, code: 'turn/hook_aborted', message: llmHookResult.reason };
      return;
    }
    const finalMessages = llmHookResult.payload.messages;

    // ── LLM stream ────────────────────────────────────────────────────────────
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let lastTextBlockIndex = 0;
    const textByIndex = new Map<number, string>();
    const thinkingByIndex = new Map<number, string>();
    const thinkingSignatureByIndex = new Map<number, string>();
    const completedThinkingIndexes = new Set<number>();

    const stream = llm.stream({ providerId, model: resolvedModel, messages: finalMessages, signal });

    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'text_delta': {
          const { cleaned, events } = emotion.processChunk(chunk.delta, turnId);
          fullText += cleaned;
          lastTextBlockIndex = chunk.blockIndex;
          if (cleaned) {
            textByIndex.set(chunk.blockIndex, (textByIndex.get(chunk.blockIndex) ?? '') + cleaned);
            yield { type: 'output_text_delta', blockIndex: chunk.blockIndex, delta: cleaned };
          }
          for (const ev of events) yield ev;
          break;
        }
        case 'thinking_delta':
          thinkingByIndex.set(chunk.blockIndex, (thinkingByIndex.get(chunk.blockIndex) ?? '') + chunk.delta);
          yield { type: 'reasoning_delta', blockIndex: chunk.blockIndex, delta: chunk.delta };
          break;
        case 'thinking_complete':
          thinkingSignatureByIndex.set(chunk.blockIndex, chunk.signature);
          completedThinkingIndexes.add(chunk.blockIndex);
          yield { type: 'reasoning_complete', blockIndex: chunk.blockIndex };
          break;
        case 'usage':
          inputTokens = chunk.inputTokens;
          outputTokens = chunk.outputTokens;
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
        yield { type: 'reasoning_complete', blockIndex };
      }
    }

    // Bug #2: mark stream done before any post-stream work so the catch block
    // knows an abort here is not a mid-stream user stop.
    llmStreamDone = true;

    // Flush scanner tail (model may have stopped mid-tag)
    const { cleaned: tail } = emotion.flush(turnId);
    if (tail) {
      fullText += tail;
      textByIndex.set(lastTextBlockIndex, (textByIndex.get(lastTextBlockIndex) ?? '') + tail);
      yield { type: 'output_text_delta', blockIndex: lastTextBlockIndex, delta: tail };
    }

    // ── Post-stream hooks + persist ───────────────────────────────────────────
    await hooks.trigger('afterLlmComplete', {
      turnId,
      sessionId: input.sessionId,
      payload: { content: fullText },
      meta: {},
    });

    const msg = session.appendMessage({
      turnId,
      sessionId: input.sessionId,
      role: 'assistant',
      // Persist visible text and provider reasoning for UI/debug history.
      // Replay to the next LLM call is handled by historyToLlmMessages(), which
      // deliberately filters thinking/tool blocks out for provider safety.
      blocks: buildAssistantBlocks(
        textByIndex,
        thinkingByIndex,
        thinkingSignatureByIndex,
        fullText,
      ) as MessageBlocks,
    });

    await hooks.trigger('afterMessage', {
      turnId,
      sessionId: input.sessionId,
      payload: { messageId: msg.id, role: 'assistant', content: fullText },
      meta: {},
    });

    const durationMs = Date.now() - startedAt;
    await hooks.trigger('onTurnEnd', {
      turnId,
      sessionId: input.sessionId,
      payload: { durationMs },
      meta: {},
    });

    session.completeTurn(turnId, { usageInputTokens: inputTokens, usageOutputTokens: outputTokens });
    yield { type: 'turn_completed', turnId, usage: { inputTokens, outputTokens, costUsd: 0, durationMs } };

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
        meta: {},
      });
      session.abortTurn(input.sessionId, turnId);
      yield { type: 'turn_aborted', turnId, reason: 'user_stop' };
    } else {
      session.failTurn(turnId, 'provider/server_error', reason);
      yield { type: 'turn_failed', turnId, code: 'provider/server_error', message: reason };
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
  ctx: Omit<HookContext<'beforeLlm'>, 'event' | 'emit'>,
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

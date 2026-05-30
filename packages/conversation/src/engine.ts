import type { EmaStreamEvent } from '@ema-agent/contracts';
import type { LlmMessage, LlmContentPart, AssistantBlock, UserBlock } from '@ema-agent/llm';
import type { Message } from '@ema-agent/session';
import type { MessageBlocks } from '@ema-agent/session';
import type { HookBus, HookContext, HookTriggerResult } from '@ema-agent/hook';
import type { ConversationDeps, ConversationRunInput } from './types.js';

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
    emotion.beginTurn();

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
      meta: { mode, userInput: input.userInput, signal },
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

    // Bug #3: collect afterLlmDelta promises so we can drain them before
    // afterLlmComplete — prevents slow hooks (TTS) from racing with turn teardown.
    const deltaPromises: Promise<unknown>[] = [];

    const stream = llm.stream({ providerId, model: resolvedModel, messages: finalMessages, signal });

    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'text_delta': {
          const { cleaned, events } = emotion.processChunk(chunk.delta, turnId);
          fullText += cleaned;
          // blockIndex: 0 — conversation engine always produces a single text block
          if (cleaned) yield { type: 'output_text_delta', blockIndex: 0, delta: cleaned };
          for (const ev of events) yield ev;
          deltaPromises.push(
            hooks.trigger('afterLlmDelta', {
              turnId,
              sessionId: input.sessionId,
              payload: { delta: cleaned, accumulated: fullText },
              meta: {},
            }),
          );
          break;
        }
        case 'usage':
          inputTokens = chunk.inputTokens;
          outputTokens = chunk.outputTokens;
          break;
      }
    }

    // Bug #2: mark stream done before any post-stream work so the catch block
    // knows an abort here is not a mid-stream user stop.
    llmStreamDone = true;

    // Flush scanner tail (model may have stopped mid-tag)
    const { cleaned: tail } = emotion.flush(turnId);
    if (tail) {
      fullText += tail;
      yield { type: 'output_text_delta', blockIndex: 0, delta: tail };
    }

    // Bug #3: drain all delta hooks before afterLlmComplete fires
    await Promise.allSettled(deltaPromises);

    // ── Post-stream hooks + persist ───────────────────────────────────────────
    await hooks.trigger('afterLlmComplete', {
      turnId,
      sessionId: input.sessionId,
      payload: { content: fullText },
      meta: {},
    });

    yield { type: 'output_text_complete', blockIndex: 0, text: fullText };

    const msg = session.appendMessage({
      turnId,
      sessionId: input.sessionId,
      role: 'assistant',
      // Store as AssistantBlock[] — the canonical block format for assistant messages
      blocks: [{ type: 'text', text: fullText }] satisfies AssistantBlock[],
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

/**
 * Converts stored Message[] to LlmMessage[] for the LLM adapter.
 *
 * Block format contract (from contracts/messages.ts):
 *   system    → blocks: string
 *   user      → blocks: string | UserBlock[]  (UserBlock[] when has media or tool_results)
 *   assistant → blocks: AssistantBlock[]
 *
 * Tool results are stored as role:'user' + kind:'tool_results' with
 * UserBlock[] containing ToolResultBlock entries — no role:'tool' exists.
 */
function historyToLlmMessages(history: Message[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const msg of history) {
    switch (msg.role) {
      case 'system':
        out.push({ role: 'system', content: typeof msg.blocks === 'string' ? msg.blocks : '' });
        break;
      case 'user':
        // blocks is string (plain text) or UserBlock[] (multimodal + tool_results)
        out.push({ role: 'user', content: msg.blocks as string | UserBlock[] });
        break;
      case 'assistant':
        // blocks is AssistantBlock[] — preserves text/thinking/tool_use interleaving
        if (Array.isArray(msg.blocks)) {
          out.push({ role: 'assistant', content: msg.blocks as AssistantBlock[] });
        }
        break;
    }
  }
  return out;
}

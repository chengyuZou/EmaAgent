import type { EmaStreamEvent } from '@ema-agent/contracts';
import type { LlmMessage, LlmToolCall, LlmContentPart } from '@ema-agent/llm';
import { validateContentParts } from '@ema-agent/llm';
import type { Message, ToolCall } from '@ema-agent/session';
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

    // ── Context + user message ────────────────────────────────────────────────
    const history = session.loadHistory(input.sessionId);
    const userContent = input.contentParts && input.contentParts.length > 0
      ? input.contentParts
      : input.userInput;

    session.appendMessage({ turnId, sessionId: input.sessionId, role: 'user', content: userContent });

    const messages: LlmMessage[] = [
      ...historyToLlmMessages(history),
      { role: 'user', content: userContent } as LlmMessage,
    ];

    const partsToCheck = Array.isArray(userContent) ? userContent : [];
    if (partsToCheck.length > 0) {
      const issues = validateContentParts(partsToCheck, 'openai-llm');
      if (issues.length > 0) {
        yield {
          type: 'system_warning',
          level: 'warn',
          message: `${issues.length} attachment(s) not supported by the current model: ${issues.map(i => i.reason).join('; ')}`,
        };
      }
    }

    // ── beforeLlm hook ────────────────────────────────────────────────────────
    // narrative:recall hook fires here (mode=narrative only), injecting RAG
    // context via replace + emitting narrative_route_resolved / recall_evidence.
    // signal + userInput are passed via meta so the hook can abort the HTTP call
    // if the user stops mid-recall (Bug #1 fix lives in the hook + NarrativeClient).
    const emitBuffer: EmaStreamEvent[] = [];
    const llmHookResult = await hooks.trigger('beforeLlm', {
      turnId,
      sessionId: input.sessionId,
      payload: { systemPrompt: '', messages },
      meta: { mode, userInput: input.userInput, signal },
      emit: (ev) => emitBuffer.push(ev),
    });

    // Bug #4: drain buffer BEFORE checking abort — events already happened and
    // the frontend needs them even if we're about to fail the turn.
    for (const ev of emitBuffer) yield ev;

    if (llmHookResult.kind === 'abort') {
      session.failTurn(turnId, 'turn/hook_aborted', llmHookResult.reason);
      yield { type: 'turn_failed', turnId, code: 'turn/hook_aborted', message: llmHookResult.reason };
      return;
    }
    const finalMessages = llmHookResult.payload.messages;

    // ── Provider resolution ───────────────────────────────────────────────────
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
          if (cleaned) yield { type: 'output_text_delta', delta: cleaned };
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
    if (tail) { fullText += tail; yield { type: 'output_text_delta', delta: tail }; }

    // Bug #3: drain all delta hooks before afterLlmComplete fires
    await Promise.allSettled(deltaPromises);

    // ── Post-stream hooks + persist ───────────────────────────────────────────
    await hooks.trigger('afterLlmComplete', {
      turnId,
      sessionId: input.sessionId,
      payload: { content: fullText },
      meta: {},
    });

    yield { type: 'output_text_complete', text: fullText };

    const msg = session.appendMessage({
      turnId,
      sessionId: input.sessionId,
      role: 'assistant',
      content: fullText,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function historyToLlmMessages(history: Message[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const msg of history) {
    switch (msg.role) {
      case 'user':
        out.push(Array.isArray(msg.content)
          ? { role: 'user', content: msg.content as LlmContentPart[] }
          : { role: 'user', content: extractText(msg.content) });
        break;
      case 'assistant': {
        const toolCalls: LlmToolCall[] | undefined = msg.toolCalls
          ? msg.toolCalls.map((tc: ToolCall) => ({ id: tc.id, name: tc.name, args: tc.args }))
          : undefined;
        out.push({ role: 'assistant', content: extractText(msg.content) || null, toolCalls });
        break;
      }
      case 'system':
        out.push({ role: 'system', content: extractText(msg.content) });
        break;
      case 'tool':
        out.push({ role: 'tool', toolCallId: msg.toolCallId ?? '', content: extractText(msg.content) });
        break;
    }
  }
  return out;
}

function extractText(content: string | unknown[]): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: 'text'; text: string } =>
        typeof p === 'object' && p !== null && (p as { type: string }).type === 'text')
      .map((p) => p.text)
      .join('');
  }
  return '';
}

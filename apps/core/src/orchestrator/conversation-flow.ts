import type { AppBindings } from '../wiring.js';
import type { EmaStreamEvent, TurnMode, SessionId } from '@ema-agent/contracts';
import type { LlmMessage, LlmToolCall, LlmContentPart } from '@ema-agent/llm';
import { validateContentParts } from '@ema-agent/llm';
import type { Message, ToolCall, Turn } from '@ema-agent/session';

// ── Public input type ─────────────────────────────────────────────────────────

export interface ChatTurnInput {
  sessionId: SessionId;
  userInput: string;
  contentParts?: LlmContentPart[];
  model?: string;
  turn: Turn;
  signal: AbortSignal;
}

// ── Main flow ─────────────────────────────────────────────────────────────────

/**
 * Chat-mode turn: single LLM call, stream tokens to SSE, no tools.
 *
 * Hook injection points:
 *   onTurnStart → beforeLlm (system prompt injected here) → llm.stream
 *   → afterLlmDelta per chunk → afterLlmComplete → afterMessage → onTurnEnd
 */
export async function* runChatTurn(
  bindings: AppBindings,
  input: ChatTurnInput,
): AsyncIterable<EmaStreamEvent> {
  const { session, hooks, llm, emotion } = bindings;
  const startedAt = Date.now();

  // ── 1. Start turn (acquires concurrency lock, heals stale runs) ──────────
  const { turn, signal } = input;
  const turnId = turn.id;
  const mode = turn.mode;

  try {
    // ── 2. Reset emotion scanner for this turn (state is preserved) ──────────
    emotion.beginTurn();

    // ── 3. onTurnStart hook ──────────────────────────────────────────────────
    const startResult = await hooks.trigger('onTurnStart', {
      turnId,
      sessionId: input.sessionId,
      payload: { mode: mode },
      meta: {},
    });
    if (startResult.kind === 'abort') {
      session.failTurn(turnId, 'turn/hook_aborted', startResult.reason);
      yield { type: 'turn_failed', turnId, code: 'turn/hook_aborted', message: startResult.reason };
      return;
    }

    // ── 4. Emit turn_started ─────────────────────────────────────────────────
    yield { type: 'turn_started', turnId, mode: mode };

    // ── 5. Load context ──────────────────────────────────────────────────────
    const history = session.loadHistory(input.sessionId);

    // ── 6. Persist user message FIRST, then build message list ───────────────
    const userContent = input.contentParts && input.contentParts.length > 0
      ? input.contentParts
      : input.userInput;

    session.appendMessage({
      turnId,
      sessionId: input.sessionId,
      role: 'user',
      content: userContent,
    });

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
        }
      }
    }

    // ── 7. beforeLlm hook → system prompt + memory recall injected here ─────
    const llmHookResult = await hooks.trigger('beforeLlm', {
      turnId,
      sessionId: input.sessionId,
      payload: { systemPrompt: '', messages },
      meta: { mode: mode },
    });
    if (llmHookResult.kind === 'abort') {
      session.failTurn(turnId, 'turn/hook_aborted', llmHookResult.reason);
      yield { type: 'turn_failed', turnId, code: 'turn/hook_aborted', message: llmHookResult.reason };
      return;
    }
    const finalMessages = llmHookResult.payload.messages;

    // ── 8. Resolve provider + model from model_bindings ─────────────────────
    //    Precedence: explicit input.model override → model_bindings for this mode
    //    → router's first registered provider + its defaultModel → hard error.
    const binding = bindings.modelBindings.get(mode as 'chat' | 'narrative' | 'agent');
    const providerId = binding?.providerConfigId ?? llm.firstProviderId();
    const resolvedModel = input.model
      ?? binding?.model
      ?? (providerId ? llm.defaultModelFor(providerId) : undefined);

    if (!providerId || !resolvedModel) {
      session.failTurn(turnId, 'provider/not_configured', 'No LLM provider configured for this mode');
      yield { type: 'turn_failed', turnId, code: 'provider/not_configured', message: 'No LLM provider configured for this mode' };
      return;
    }

    // ── 9. LLM stream ────────────────────────────────────────────────────────
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const stream = llm.stream({
      providerId,
      model: resolvedModel,
      messages: finalMessages,
      signal,
    });

    // ── 10. Per-chunk processing ─────────────────────────────────────────────
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'text_delta': {
          // Strip ACT tags inline; get cleaned text + any emotion/stage events.
          const { cleaned, events } = emotion.processChunk(chunk.delta, turnId);
          fullText += cleaned;

          // Yield cleaned delta first so text appears before the animation fires.
          if (cleaned) yield { type: 'output_text_delta', delta: cleaned };
          // Then yield emotion / stage_cue events derived from this chunk.
          for (const event of events) yield event;

          // afterLlmDelta hook receives the cleaned delta so downstream
          // observers (telemetry, TTS) always see tag-free text.
          hooks.trigger('afterLlmDelta', {
            turnId,
            sessionId: input.sessionId,
            payload: { delta: cleaned, accumulated: fullText },
            meta: {},
          });
          break;
        }
        case 'usage':
          inputTokens = chunk.inputTokens;
          outputTokens = chunk.outputTokens;
          break;
        // tool_use_delta / tool_use_complete not expected in chat mode with no tools;
        // silently skip for forward compatibility
      }
    }

    // ── 11. Flush scanner tail (model may have stopped mid-tag) ─────────────
    const { cleaned: tail } = emotion.flush(turnId);
    if (tail) {
      fullText += tail;
      yield { type: 'output_text_delta', delta: tail };
    }

    // ── 12. afterLlmComplete hook ────────────────────────────────────────────
    // fullText is now complete and clean (no ACT tags).
    await hooks.trigger('afterLlmComplete', {
      turnId,
      sessionId: input.sessionId,
      payload: { content: fullText },
      meta: {},
    });

    // ── 13. Signal end of text stream ────────────────────────────────────────
    yield { type: 'output_text_complete', text: fullText };

    // ── 14. Persist assistant message ────────────────────────────────────────
    const msg = session.appendMessage({
      turnId,
      sessionId: input.sessionId,
      role: 'assistant',
      content: fullText,
    });

    // ── 15. afterMessage hook ────────────────────────────────────────────────
    await hooks.trigger('afterMessage', {
      turnId,
      sessionId: input.sessionId,
      payload: { messageId: msg.id, role: 'assistant', content: fullText },
      meta: {},
    });

    // ── 16. onTurnEnd hook ───────────────────────────────────────────────────
    const durationMs = Date.now() - startedAt;
    await hooks.trigger('onTurnEnd', {
      turnId,
      sessionId: input.sessionId,
      payload: { durationMs },
      meta: {},
    });

    // ── 17. Complete turn ────────────────────────────────────────────────────
    session.completeTurn(turnId, {
      usageInputTokens: inputTokens,
      usageOutputTokens: outputTokens,
    });

    yield {
      type: 'turn_completed',
      turnId,
      usage: { inputTokens, outputTokens, costUsd: 0, durationMs },
    };
  } catch (err) {
    // ── Error path ───────────────────────────────────────────────────────────
    const reason = err instanceof Error ? err.message : String(err);

    if (signal.aborted) {
      await hooks.trigger('onTurnAbort', {
        turnId,
        sessionId: input.sessionId,
        payload: { reason: 'user_stop' },
        meta: {},
      });
      session.abortTurn(input.sessionId, turnId);

      // Persist partial response so the user doesn't lose generated text
      yield { type: 'turn_aborted', turnId, reason: 'user_stop' };
    } else {
      session.failTurn(turnId, 'provider/server_error', reason);
      yield { type: 'turn_failed', turnId, code: 'provider/server_error', message: reason };
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert session Message rows to LLM-ready message format.
 * For chat mode (no tools yet), this handles user + assistant messages.
 */
function historyToLlmMessages(history: Message[]): LlmMessage[] {
  const out: LlmMessage[] = [];

  for (const msg of history) {
    switch (msg.role) {
      case 'user':
        if (Array.isArray(msg.content)) {
          out.push({ role: 'user', content: msg.content as LlmContentPart[] });
        } else {
          out.push({ role: 'user', content: extractTextContent(msg.content) });
        }
        break;
      case 'assistant': {
        const content = extractTextContent(msg.content);
        const toolCalls: LlmToolCall[] | undefined = msg.toolCalls
          ? msg.toolCalls.map((tc: ToolCall) => ({
              id: tc.id,
              name: tc.name,
              args: tc.args,
            }))
          : undefined;
        out.push({ role: 'assistant', content: content || null, toolCalls });
        break;
      }
      case 'system':
        out.push({ role: 'system', content: extractTextContent(msg.content) });
        break;
      case 'tool':
        out.push({ role: 'tool', toolCallId: msg.toolCallId ?? '', content: extractTextContent(msg.content) });
        break;
    }
  }

  return out;
}

function extractTextContent(content: string | unknown[]): string {
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

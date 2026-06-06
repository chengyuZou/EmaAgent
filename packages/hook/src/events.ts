import type { TurnMode, MessageId } from '@ema-agent/contracts';
import type { LlmMessage } from '@ema-agent/llm';

/**
 * All hook events are turn-scoped internal engine lifecycle events.
 *
 * Two events from the CLAUDE.md spec are intentionally absent here:
 *   - onCharacterCardSwitch  → emitted directly as `character_card_switched` EmaStreamEvent
 *   - onEmotionChange        → emitted directly as `emotion_changed` EmaStreamEvent
 * These are app-level notifications with no need for hook interception or
 * priority ordering, so they skip the HookBus entirely.
 */
export type HookEvent =
  | 'beforeLlm'
  | 'afterLlmComplete'
  | 'afterMessage'
  | 'beforeToolUse'
  | 'afterToolUse'
  | 'onToolFailure'
  | 'beforeCompact'
  | 'afterCompact'
  | 'onTurnStart'
  | 'onTurnEnd'
  | 'onTurnAbort';

// ── Per-event payload shapes ──────────────────────────────────────────────────

export interface HookPayload {
  beforeLlm: {
    /**
     * Convenience copy of the system prompt text for hooks that need to read it
     * without having to find it inside `messages`. Populated by the
     * `prompts:buildSystem` hook registered in wiring.ts.
     *
     * The engine (conversation-flow) only consumes `messages` — it does not
     * read this field. Hooks that want to replace the system prompt should
     * update both this field AND messages[0] to keep them in sync.
     */
    systemPrompt: string;
    messages: LlmMessage[];
  };
  afterLlmComplete: {
    content: string;
    toolCalls?: unknown[];
  };
  afterMessage: {
    messageId: MessageId;
    role: string;
    content: string;
  };
  beforeToolUse: {
    callId: string;
    name: string;
    args: unknown;
  };
  afterToolUse: {
    callId: string;
    name: string;
    output: unknown;
  };
  onToolFailure: {
    callId: string;
    name: string;
    error: unknown;
  };
  beforeCompact: {
    messageCount: number;
    tokenEstimate: number;
  };
  afterCompact: {
    before: number;
    after: number;
    method: string;
  };
  onTurnStart: {
    mode: TurnMode;
    subMode?: string;
  };
  onTurnEnd: {
    durationMs: number;
  };
  onTurnAbort: {
    reason: string;
  };
}

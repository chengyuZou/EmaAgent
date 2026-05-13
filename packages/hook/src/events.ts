import type { TurnMode, MessageId } from '@ema-agent/contracts';
import type { LlmMessage } from '@ema-agent/llm';

/**
 * All hook events are turn-scoped.
 * App-level notifications (character-card switch, emotion change) are
 * handled by simple callbacks / emitters in their respective packages,
 * not by the HookBus.
 */
export type HookEvent =
  | 'beforeLlm'
  | 'afterLlmDelta'
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
    systemPrompt: string;
    messages: LlmMessage[];
  };
  afterLlmDelta: {
    delta: string;
    accumulated: string;
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

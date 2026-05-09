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
  | 'onTurnAbort'
  | 'onCharacterCardSwitch'
  | 'onEmotionChange';

// ── Per-event payload shapes ──────────────────────────────────────────────────

export interface HookPayload {
  beforeLlm: {
    systemPrompt: string;
    messages: unknown[];
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
    messageId: string;
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
    mode: string;
    subMode?: string;
  };
  onTurnEnd: {
    durationMs: number;
  };
  onTurnAbort: {
    reason: string;
  };
  onCharacterCardSwitch: {
    previousCardId: string;
    nextCardId: string;
  };
  onEmotionChange: {
    primary: string;
    secondary?: string;
    intensity: number;
  };
}

import type { TurnMode, MessageId, MessageRole, AssistantBlock, LlmMessage } from '@ema-agent/contracts';

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
    /** Tool-use blocks produced by this LLM response, in block order. */
    toolCalls?: Array<Extract<AssistantBlock, { type: 'tool_use' }>>;
  };
  afterMessage: {
    messageId: MessageId;
    role: MessageRole;
    content: string;
  };
  /**
   * Fires immediately before a tool executes — for UI and audit only.
   *
   * Tool permission decisions (allow / ask / deny) are made by PermissionEngine
   * before this hook fires. The sandbox execution boundary is enforced by
   * CommandRunner. This hook cannot intercept, modify, or cancel tool execution.
   * Use it to update the UI (show "running tool…") or record audit logs.
   */
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
  };
  onTurnEnd: {
    durationMs: number;
  };
  onTurnAbort: {
    reason: string;
  };
}

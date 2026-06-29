// ── LoopState — immutable agent loop state machine ───────────────────────────
//
// Every mutation returns a new frozen object. The `transition` field records
// WHY we entered this state — essential for debugging infinite loops and for
// crash-recovery journals that need to reconstruct "what was happening".
//
// Mirrors Claude Code's LoopState / LoopTransition pattern, simplified to
// EmaAgent's subset of termination conditions.

export type LoopPhase =
  | 'preprocessing'  // running context budget + compaction checks
  | 'thinking'       // LLM streaming
  | 'acting'         // tools executing
  | 'waiting_user'   // loop parked on ask_user response
  | 'done'           // clean exit (no tool calls)
  | 'aborted'        // user or signal abort
  | 'failed';        // unrecoverable error

// Why the loop continued into this state. Stored on every transition so the
// next iteration can detect degenerate loops (e.g. repeated tool failures).
export type LoopTransition =
  | 'initial'
  | 'next_turn'                    // normal tool-call → continue
  | 'no_tool_calls'                // LLM returned text only → done
  | 'user_abort'
  | 'max_iterations'
  | 'hook_abort'
  | 'llm_error'
  | 'waiting_user'
  | 'user_answered'
  | 'user_timeout'
  | 'user_cancel'
  | 'max_output_tokens_recovery'   // output truncated → inject continuation prompt and retry once
  | 'reactive_compact';            // prompt too long → compact then retry

export interface LoopState {
  readonly phase:      LoopPhase;
  readonly iteration:  number;
  readonly transition: LoopTransition;
  readonly usage:      { inputTokens: number; outputTokens: number };
  /** 0 = not attempted; 1 = continuation prompt sent (next truncation → loop_breaker). */
  readonly maxOutputTokensRecoveryCount: number;
  /** Whether a reactive compact has already been attempted this iteration. */
  readonly hasAttemptedReactiveCompact: boolean;
  /** Populated only when phase === 'waiting_user'. */
  readonly pendingPromptId?: string;
}

// ── Factory + transition ──────────────────────────────────────────────────────

export function createLoopState(): LoopState {
  return Object.freeze({
    phase:                       'preprocessing',
    iteration:                   0,
    transition:                  'initial',
    usage:                       { inputTokens: 0, outputTokens: 0 },
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
  });
}

/**
 * Return a new LoopState with the supplied fields merged in. The original
 * state is never mutated. `transition` is required on every call so the
 * reason for every state change is always explicit.
 */
export function advanceState(
  state:  LoopState,
  update: { phase: LoopPhase; transition: LoopTransition } & Partial<Omit<LoopState, 'phase' | 'transition'>>,
): LoopState {
  return Object.freeze({ ...state, ...update });
}

export function addUsage(
  state:  LoopState,
  delta:  { inputTokens: number; outputTokens: number },
): LoopState {
  return Object.freeze({
    ...state,
    usage: {
      inputTokens:  state.usage.inputTokens  + delta.inputTokens,
      outputTokens: state.usage.outputTokens + delta.outputTokens,
    },
  });
}

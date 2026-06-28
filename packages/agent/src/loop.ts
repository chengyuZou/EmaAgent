import type { LlmMessage, AssistantBlock, UserBlock, ToolResultBlock, EmaStreamEvent } from '@ema-agent/contracts';
import type { LlmRouter, ThinkingMode } from '@ema-agent/llm';
import type { AgentPolicy } from './policy.js';
import type { TurnToolExecutor } from './tool-executor.js';
import { advanceState, addUsage, createLoopState } from './loop-state.js';
import type { LoopState } from './loop-state.js';

// ── AgentLoopEvent — internal, not EmaStreamEvent ────────────────────────────
//
// Loop yields only the events it generates itself.  Tool events (tool_result,
// permission_required, ask_user_required, …) come through two paths:
//
//   loop_relay        — executor event forwarded verbatim; engine yields as-is.
//   loop_llm_complete — LLM stream ended; engine should flush emotion + fire
//                       afterLlmComplete hook.
//   loop_tool_results — all tools finished; engine persists to session DB.
//
// Emotion processing (ACT tag stripping) is intentionally NOT in the loop.
// engine.ts intercepts loop_text_delta and runs emotion.processChunk() before
// yielding output_text_delta to SSE.

export type AgentLoopEvent =
  | { type: 'loop_iteration';     n: number; state: LoopState }
  | { type: 'loop_text_delta';    delta: string; blockIndex: number }
  | { type: 'loop_thinking_delta';delta: string; blockIndex: number }
  | { type: 'loop_tool_partial';  callId: string; name: string; argsDelta: string; blockIndex: number }
  | { type: 'loop_tool_complete'; callId: string; name: string; args: unknown; blockIndex: number }
  | { type: 'loop_relay';         ev: EmaStreamEvent }
  | { type: 'loop_llm_complete' }
  | { type: 'loop_tool_results';  results: ToolResultBlock[]; fullText: string }
  | { type: 'loop_breaker';       reason: string }
  | { type: 'loop_done';          fullText: string; state: LoopState };

// ── AgentLoopInput ────────────────────────────────────────────────────────────

/**
 * Factory called by the loop to build its TurnToolExecutor.
 * The loop provides the internal wakeUp/relay callbacks; the caller bakes in
 * all the session/permission/hook deps it knows about.
 */
export type ExecutorFactory = (internals: {
  /** Called by executor for every event it generates (tool_result, permission_required, …). */
  pushEv:  (ev: EmaStreamEvent) => void;
  /** Called by executor when a tool finishes, so the loop's drain-wait unparks. */
  signal:  () => void;
}) => TurnToolExecutor;

export interface AgentLoopInput {
  /** Mutable messages array. Loop appends each round's assistant + tool-result messages. */
  messages:       LlmMessage[];
  policy:         AgentPolicy;
  /** Called once at loop construction. Provides the loop's internal relay callbacks. */
  buildExecutor:  ExecutorFactory;
  llm:            LlmRouter;
  providerId:     string;
  model:          string;
  signal:         AbortSignal;
  maxIterations:  number;
  sessionId:      string;
  /**
   * Called before each LLM call. When it returns a non-empty string, the loop
   * prepends an ephemeral user message containing that string to the messages
   * sent to the LLM — without mutating the persistent messages[].
   * Used to inject current scratchpad state so agents see what sub-agents wrote.
   */
  getScratchpadContext?: () => string | undefined;
  /**
   * Called before each LLM call. Returns any messages queued via
   * subagent_send_message since the last iteration, then atomically clears
   * the queue. Each string is injected as a separate ephemeral user message
   * so the agent sees mid-execution coordinator instructions.
   * Only populated for background sub-agents; always undefined for the main agent.
   */
  getMailboxMessages?: () => string[];
  /**
   * Called at the top of every iteration before the LLM call.
   * Runs compaction on the accumulated messages and returns the (possibly
   * compacted) replacement array. Mutates messages[] in place so subsequent
   * iterations and the spawner both see the compacted history.
   * Engine wires this to MemoryPlanner.compact(); spawner omits it (ephemeral).
   */
  compactMessages?: (messages: LlmMessage[]) => Promise<LlmMessage[]>;
  thinking?: ThinkingMode;
}

// ── agentLoop ─────────────────────────────────────────────────────────────────

/**
 * Pure think→act loop. No session store, no hook bus, no EmaStreamEvent yield
 * (except as loop_relay wrappers).
 *
 * Callers:
 *   engine.ts   — wraps with session lifecycle + beforeLlm hook + emotion + SSE
 *   spawner.ts  — ephemeral context, collects fullText + usage from loop_done
 *
 * Tool events (executor pushEv) are collected in pendingRelayEvents and yielded
 * as loop_relay between every LLM chunk and during the drain-wait.
 * The TOCTOU-safe park pattern prevents the drain-wait from blocking forever
 * if the last tool finishes between the allDone() check and await.
 */
export async function* agentLoop(input: AgentLoopInput): AsyncIterable<AgentLoopEvent> {
  const { messages, policy, llm, providerId, model, signal, maxIterations, getScratchpadContext, getMailboxMessages, compactMessages, thinking } = input;

  const pendingRelayEvents: EmaStreamEvent[] = [];
  let wakeUp: (() => void) | null = null;
  const signalWake = (): void => { wakeUp?.(); wakeUp = null; };

  const executor = input.buildExecutor({
    pushEv: (ev: EmaStreamEvent) => { pendingRelayEvents.push(ev); signalWake(); },
    signal: signalWake,
  });

  let state = createLoopState();

  while (true) {
    if (signal.aborted) {
      state = advanceState(state, { phase: 'aborted', transition: 'user_abort' });
      yield { type: 'loop_done', fullText: '', state };
      return;
    }

    state = advanceState(state, {
      phase:      'thinking',
      transition: state.iteration === 0 ? 'initial' : 'next_turn',
      iteration:  state.iteration + 1,
    });
    yield { type: 'loop_iteration', n: state.iteration, state };

    executor.reset();

    // ── THINK: stream one LLM response ──────────────────────────────────────
    const textByIndex     = new Map<number, string>();
    const thinkingByIndex = new Map<number, string>();
    const toolUseByIndex  = new Map<number, AssistantBlock & { type: 'tool_use' }>();

    // Per-iteration compaction: runs before every LLM call so agent loops that
    // accumulate many tool results don't overflow the context window mid-turn.
    // Mutates messages[] in place; spawner omits compactMessages (ephemeral ctx).
    if (compactMessages) {
      const compacted = await compactMessages([...messages]);
      messages.splice(0, messages.length, ...compacted);
    }

    // Inject scratchpad context and mailbox messages as ephemeral user messages
    // before each LLM call — not persisted into messages[].
    // Mailbox messages are drained atomically so each is only seen once.
    const scratchpadCtx  = getScratchpadContext?.();
    const mailboxMsgs    = getMailboxMessages?.() ?? [];
    const effectiveMessages: LlmMessage[] = [
      ...messages,
      ...(scratchpadCtx ? [{ role: 'user' as const, content: scratchpadCtx }] : []),
      ...mailboxMsgs.map(m => ({ role: 'user' as const, content: `[Coordinator]: ${m}` })),
    ];

    const stream = llm.stream({
      providerId, model,
      messages:   effectiveMessages,
      tools:      policy.toolDefs(),
      toolChoice: 'auto',
      thinking,
      signal,
    });

    for await (const chunk of stream) {
      // Drain relay events between LLM chunks — tools may have fired concurrently.
      while (pendingRelayEvents.length > 0) {
        yield { type: 'loop_relay', ev: pendingRelayEvents.shift()! };
      }

      switch (chunk.type) {
        case 'text_delta':
          textByIndex.set(chunk.blockIndex, (textByIndex.get(chunk.blockIndex) ?? '') + chunk.delta);
          yield { type: 'loop_text_delta', delta: chunk.delta, blockIndex: chunk.blockIndex };
          break;

        case 'thinking_delta':
          thinkingByIndex.set(chunk.blockIndex, (thinkingByIndex.get(chunk.blockIndex) ?? '') + chunk.delta);
          yield { type: 'loop_thinking_delta', delta: chunk.delta, blockIndex: chunk.blockIndex };
          break;

        case 'tool_use_delta':
          yield { type: 'loop_tool_partial', callId: chunk.callId, name: chunk.name, argsDelta: chunk.argsDelta, blockIndex: chunk.blockIndex };
          break;

        case 'tool_use_complete':
          toolUseByIndex.set(chunk.blockIndex, {
            type: 'tool_use', id: chunk.callId, name: chunk.name, args: chunk.args,
          });
          yield { type: 'loop_tool_complete', callId: chunk.callId, name: chunk.name, args: chunk.args, blockIndex: chunk.blockIndex };
          // Start executing immediately — concurrent-safe tools run in parallel.
          executor.addTool(chunk.blockIndex, chunk.callId, chunk.name, chunk.args);
          break;

        case 'usage':
          state = addUsage(state, { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens });
          break;
      }
    }

    const fullText = [...textByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, t]) => t)
      .join('');

    // Signal LLM stream end — engine flushes emotion + fires afterLlmComplete.
    yield { type: 'loop_llm_complete' };

    // ── End condition: no tool calls → done ──────────────────────────────────
    if (toolUseByIndex.size === 0) {
      const blockMap = buildBlockMap(textByIndex, thinkingByIndex, new Map());
      messages.push({ role: 'assistant', content: blockMap });

      state = advanceState(state, { phase: 'done', transition: 'no_tool_calls' });
      yield { type: 'loop_done', fullText, state };
      return;
    }

    // ── ACT: wait for all tools, draining relay events as they arrive ────────
    state = advanceState(state, { phase: 'acting', transition: 'next_turn' });

    while (!executor.allDone() || pendingRelayEvents.length > 0) {
      while (pendingRelayEvents.length > 0) {
        yield { type: 'loop_relay', ev: pendingRelayEvents.shift()! };
      }
      if (executor.allDone()) break;

      // Install resolver BEFORE re-checking — avoids TOCTOU deadlock where the
      // last tool finishes between allDone() and the await assignment.
      const parked = new Promise<void>(r => { wakeUp = r; });
      if (executor.allDone() || pendingRelayEvents.length > 0) { wakeUp = null; continue; }
      await parked;
    }
    // Final relay drain after drain-wait exits.
    while (pendingRelayEvents.length > 0) {
      yield { type: 'loop_relay', ev: pendingRelayEvents.shift()! };
    }

    const resultBlocks: ToolResultBlock[] = executor.getResults();

    // Persist round: assistant (tool_use) + user (tool_result) into messages[].
    const allBlocks    = buildBlockMap(textByIndex, thinkingByIndex, toolUseByIndex);
    const replayBlocks = allBlocks.filter(b => b.type !== 'thinking');
    messages.push({ role: 'assistant', content: replayBlocks });
    messages.push({ role: 'user', content: resultBlocks as UserBlock[] });

    // Signal engine to persist tool results to session DB.
    yield { type: 'loop_tool_results', results: resultBlocks, fullText };

    // ── Circuit breaker ──────────────────────────────────────────────────────
    if (state.iteration >= maxIterations) {
      const reason = `max iterations (${maxIterations}) reached`;
      state = advanceState(state, { phase: 'done', transition: 'max_iterations' });
      yield { type: 'loop_breaker', reason };
      yield { type: 'loop_done', fullText, state };
      return;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildBlockMap(
  textByIndex:    Map<number, string>,
  thinkingByIndex:Map<number, string>,
  toolUseByIndex: Map<number, AssistantBlock & { type: 'tool_use' }>,
): AssistantBlock[] {
  const blockMap = new Map<number, AssistantBlock>();
  for (const [idx, text]     of textByIndex)     blockMap.set(idx, { type: 'text', text });
  for (const [idx, thinking] of thinkingByIndex) blockMap.set(idx, { type: 'thinking', thinking });
  for (const [idx, b]        of toolUseByIndex)  blockMap.set(idx, b);
  return [...blockMap.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
}

// ── Re-export types needed by callers ────────────────────────────────────────

export type { LoopState };

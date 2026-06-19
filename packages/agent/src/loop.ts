import type { LlmMessage, AssistantBlock, UserBlock, ToolResultBlock } from '@ema-agent/contracts';
import type { LlmRouter } from '@ema-agent/llm';
import type { EmotionEngine } from '@ema-agent/emotion';
import type { AskUserQuestionSpec } from '@ema-agent/contracts';
import { AgentPolicy } from './policy.js';
import { TurnToolExecutor } from './tool-executor.js';
import { advanceState, addUsage, createLoopState } from './loop-state.js';
import type { LoopState } from './loop-state.js';

// ── AgentLoopInput ────────────────────────────────────────────────────────────

/**
 * Everything agentLoop() needs. Deliberately excludes session/hooks/SSE —
 * those belong to the callers (engine.ts for root, spawner.ts for subagents).
 *
 * `messages` is mutated in-place by the loop: the caller passes its own
 * array and the loop appends assistant + tool-result turns to it directly.
 * This allows ForkRunner to share a parent messages[] prefix efficiently.
 */
export interface AgentLoopInput {
  messages:      LlmMessage[];
  policy:        AgentPolicy;
  executor:      TurnToolExecutor;
  llm:           LlmRouter;
  providerId:    string;
  model:         string;
  signal:        AbortSignal;
  maxIterations: number;
  /** Optional: only wired for root agents (subagents skip emotion). */
  emotion?:      EmotionEngine;
  /** Passed through to AgentLoopEvent for the caller to map to SSE. */
  sessionId:     string;
}

// ── AgentLoopEvent — internal events, NOT EmaStreamEvent ─────────────────────

export type AgentLoopEvent =
  | { type: 'iteration';          n: number; state: LoopState }
  | { type: 'text_delta';         delta: string; blockIndex: number }
  | { type: 'thinking_delta';     delta: string; blockIndex: number }
  | { type: 'tool_call_partial';  callId: string; name: string; argsDelta: string; blockIndex: number }
  | { type: 'tool_call_complete'; callId: string; name: string; args: unknown; blockIndex: number }
  | { type: 'tool_result_event';  callId: string; output?: unknown; error?: { code: string; message: string } }
  | { type: 'waiting_user';       promptId: string; questions: AskUserQuestionSpec[] }
  | { type: 'breaker_tripped';    reason: string }
  | { type: 'loop_done';          fullText: string; state: LoopState };

// ── agentLoop ─────────────────────────────────────────────────────────────────

/**
 * Pure think→act loop. No session store, no hook bus, no SSE types.
 *
 * Callers:
 *   engine.ts   — wraps with session lifecycle + hook triggers + SSE translation
 *   spawner.ts  — wraps with ephemeral context, collects final text output
 *
 * The loop mutates input.messages (appends each round's assistant + tool-result
 * messages). Callers that need a pristine copy should pass a slice.
 */
export async function* agentLoop(input: AgentLoopInput): AsyncIterable<AgentLoopEvent> {
  const { messages, policy, executor, llm, providerId, model, signal, emotion, sessionId } = input;

  // Shared event queue: TurnToolExecutor pushes raw SSE events; we relay them.
  // The queue + wakeUp pattern is identical to engine.ts — tools push while LLM
  // streams, we drain between chunks.
  const pendingToolEvents: AgentLoopEvent[] = [];
  let wakeUp: (() => void) | null = null;
  const signalWake = (): void => { wakeUp?.(); wakeUp = null; };

  const toolEmit = (ev: AgentLoopEvent): void => {
    pendingToolEvents.push(ev);
    signalWake();
  };

  let state = createLoopState();

  while (true) {
    if (signal.aborted) {
      state = advanceState(state, { phase: 'aborted', transition: 'user_abort' });
      break;
    }

    state = advanceState(state, {
      phase:      'thinking',
      transition: state.iteration === 0 ? 'initial' : 'next_turn',
      iteration:  state.iteration + 1,
    });
    yield { type: 'iteration', n: state.iteration, state };

    executor.reset();

    // ── THINK: stream one LLM response ──────────────────────────────────────
    const textByIndex     = new Map<number, string>();
    const thinkingByIndex = new Map<number, string>();
    const toolUseByIndex  = new Map<number, AssistantBlock & { type: 'tool_use' }>();

    const stream = llm.stream({
      providerId, model,
      messages,
      tools:      policy.toolDefs(),
      toolChoice: 'auto',
      signal,
    });

    for await (const chunk of stream) {
      while (pendingToolEvents.length > 0) yield pendingToolEvents.shift()!;

      switch (chunk.type) {
        case 'text_delta': {
          const { cleaned, events: emotionEvs } = emotion
            ? emotion.processChunk(chunk.delta, 'loop', sessionId)
            : { cleaned: chunk.delta, events: [] };

          if (cleaned) {
            textByIndex.set(chunk.blockIndex, (textByIndex.get(chunk.blockIndex) ?? '') + cleaned);
            yield { type: 'text_delta', delta: cleaned, blockIndex: chunk.blockIndex };
          }
          for (const ev of emotionEvs) {
            // Emotion events are EmaStreamEvent — the caller (engine.ts) handles
            // them via a translateEvent() wrapper. We can't yield them here
            // because AgentLoopEvent and EmaStreamEvent are different types.
            // engine.ts passes emotion separately and handles emotion events
            // by processing them outside the loop. Skip for subagents (no emotion).
          }
          break;
        }

        case 'thinking_delta':
          thinkingByIndex.set(chunk.blockIndex, (thinkingByIndex.get(chunk.blockIndex) ?? '') + chunk.delta);
          yield { type: 'thinking_delta', delta: chunk.delta, blockIndex: chunk.blockIndex };
          break;

        case 'tool_use_delta':
          yield { type: 'tool_call_partial', callId: chunk.callId, name: chunk.name, argsDelta: chunk.argsDelta, blockIndex: chunk.blockIndex };
          break;

        case 'tool_use_complete':
          toolUseByIndex.set(chunk.blockIndex, {
            type: 'tool_use', id: chunk.callId, name: chunk.name, args: chunk.args,
          });
          yield { type: 'tool_call_complete', callId: chunk.callId, name: chunk.name, args: chunk.args, blockIndex: chunk.blockIndex };
          executor.addTool(chunk.blockIndex, chunk.callId, chunk.name, chunk.args);
          break;

        case 'usage':
          state = addUsage(state, { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens });
          break;
      }
    }

    // Flush emotion tail
    if (emotion) {
      const { cleaned: tail } = emotion.flush('loop', sessionId);
      if (tail) {
        const textIdx = textByIndex.size > 0 ? Math.min(...textByIndex.keys()) : 0;
        textByIndex.set(textIdx, (textByIndex.get(textIdx) ?? '') + tail);
        yield { type: 'text_delta', delta: tail, blockIndex: textIdx };
      }
    }

    const fullText = [...textByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, t]) => t)
      .join('');

    // ── End condition: no tool calls ─────────────────────────────────────────
    if (toolUseByIndex.size === 0) {
      while (pendingToolEvents.length > 0) yield pendingToolEvents.shift()!;

      // Persist final assistant message into messages[] for the caller
      const blockMap = new Map<number, AssistantBlock>();
      for (const [idx, text]     of textByIndex)     blockMap.set(idx, { type: 'text', text });
      for (const [idx, thinking] of thinkingByIndex) blockMap.set(idx, { type: 'thinking', thinking });
      const allBlocks = [...blockMap.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
      messages.push({ role: 'assistant', content: allBlocks });

      state = advanceState(state, { phase: 'done', transition: 'no_tool_calls' });
      yield { type: 'loop_done', fullText, state };
      return;
    }

    // ── ACT: drain tool events and wait for all tools ────────────────────────
    state = advanceState(state, { phase: 'acting', transition: 'next_turn' });

    while (!executor.allDone() || pendingToolEvents.length > 0) {
      while (pendingToolEvents.length > 0) {
        const ev = pendingToolEvents.shift()!;
        yield ev;
      }
      if (executor.allDone()) break;

      const parked = new Promise<void>(r => { wakeUp = r; });
      if (executor.allDone() || pendingToolEvents.length > 0) {
        wakeUp = null;
        continue;
      }
      await parked;
    }

    // Rebuild allBlocks including tool_use
    const blockMap = new Map<number, AssistantBlock>();
    for (const [idx, text]     of textByIndex)     blockMap.set(idx, { type: 'text', text });
    for (const [idx, thinking] of thinkingByIndex) blockMap.set(idx, { type: 'thinking', thinking });
    for (const [idx, b]        of toolUseByIndex)  blockMap.set(idx, b);
    const allBlocks = [...blockMap.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);

    const resultBlocks: ToolResultBlock[] = executor.getResults();

    // Append to messages[] (mutable — caller's array, or fork-shared array)
    messages.push({ role: 'assistant', content: allBlocks.filter(b => b.type !== 'thinking') });
    messages.push({ role: 'user', content: resultBlocks as UserBlock[] });

    // ── Circuit breaker ──────────────────────────────────────────────────────
    if (state.iteration >= input.maxIterations) {
      const reason = `max iterations (${input.maxIterations}) reached`;
      state = advanceState(state, { phase: 'done', transition: 'max_iterations' });
      yield { type: 'breaker_tripped', reason };
      yield { type: 'loop_done', fullText, state };
      return;
    }

    // Next preprocessing pass happens at the top of the while loop.
    // (memory's beforeLlm hook is triggered by engine.ts before each LLM call,
    //  not here — keeps loop.ts free of hook/session deps.)
  }

  // Aborted path
  yield { type: 'loop_done', fullText: '', state };
}

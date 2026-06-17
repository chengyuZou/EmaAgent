import type { EmaStreamEvent, LlmMessage, AssistantBlock, UserBlock, ToolResultBlock, MessageContentPart as LlmContentPart } from '@ema-agent/contracts';
import type { MessageBlocks } from '@ema-agent/session';
import type { ToolExecutionContext, ReadFileState } from '@ema-agent/tool';
import type { PermissionContext } from '@ema-agent/permission';
import type { AgentDeps, AgentRunInput } from './types.js';
import { AgentPolicy } from './policy.js';
import { TurnToolExecutor } from './tool-executor.js';
import { historyToLlmMessages } from '@ema-agent/session';
import { clearTodos } from '@ema-agent/tool-builtin';

// ── AgentEngine ───────────────────────────────────────────────────────────────

/**
 * Handles agent turns via a streaming think→act multi-round loop.
 *
 * Contract:
 *  - Caller must have called session.startTurn() and passes the resulting turn + signal.
 *  - Engine is transport-agnostic: returns AsyncIterable<EmaStreamEvent>.
 *  - All cross-cutting concerns (memory, TTS, OOC) live in hooks — engine has none.
 *
 * Tool execution pattern (mirrors Claude Code's StreamingToolExecutor):
 *  - addTool() is called immediately on each tool_use_complete event — tools start
 *    executing while the LLM is still streaming the rest of its response.
 *  - Concurrent-safe tools (isConcurrencySafe() === true) run in parallel.
 *  - Non-concurrent tools run sequentially behind a serial fence.
 *  - The engine drains pending tool events between LLM chunks and after stream end.
 */
export class AgentEngine {
  constructor(private readonly deps: AgentDeps) {}

  run(input: AgentRunInput): AsyncIterable<EmaStreamEvent> {
    return runTurn(this.deps, input);
  }
}

// ── Core turn loop ────────────────────────────────────────────────────────────

async function* runTurn(
  deps: AgentDeps,
  input: AgentRunInput,
): AsyncIterable<EmaStreamEvent> {
  const { session, hooks, llm, emotion, tools, permission, askUserRegistry } = deps;
  const { turn, signal, subMode, userInput, systemPrompt, workspaceRoots, providerId, model } = input;
  const sessionId = turn.sessionId;
  const turnId    = turn.id;
  const startedAt = Date.now();

  // Per-turn state
  const policy        = new AgentPolicy(subMode, tools.list());
  const readFileState = new Map() as ReadFileState;

  // Per-session context stores (file state + tool result offload).
  // Absent when getContextStores is not wired (tests / non-agent hosts).
  const contextStores = deps.getContextStores?.(sessionId);
  let totalInput      = 0;
  let totalOutput     = 0;
  let iterations      = 0;

  // ── Event queue shared between executor and main loop ────────────────────────
  // Tools push events here; the main loop yields them between LLM chunks and
  // after the stream ends. wakeUp resolves the drain-loop's wait promise.
  const pendingToolEvents: EmaStreamEvent[] = [];
  let   wakeUp: (() => void) | null = null;
  const signal_ = () => { wakeUp?.(); wakeUp = null; };
  const toolEmit = (ev: EmaStreamEvent) => { pendingToolEvents.push(ev); signal_(); };

  // ── ToolExecutionContext (stable across iterations) ───────────────────────────
  const permCtx: PermissionContext = {
    workspaceRoots,
    sessionId,
  };

  const resolvedRunner = deps.getCommandRunner?.(sessionId);

  const toolCtx: ToolExecutionContext = {
    sessionId,
    turnId,
    workspaceRoots,
    signal,
    readFileState,
    fileStateStore: contextStores?.fileStateStore,
    emit:          toolEmit,
    commandRunner: resolvedRunner,
    artifactStore: deps.artifactStore,
    askUser: askUserRegistry
      ? async (promptId, _questions) => {
          // IMPORTANT: use createWithId so the registry is keyed to the same
          // promptId the tool already broadcast in `ask_user_required`. The
          // frontend will POST back that exact promptId; a mismatched key means
          // respond() returns false and the promise never resolves.
          const { promise } = askUserRegistry.createWithId(promptId, undefined, turnId as string);
          return { answers: await promise };
        }
      : undefined,
  };

  // ── Streaming executor (shared, reset each iteration) ────────────────────────
  const executor = new TurnToolExecutor({
    sessionId,
    turnId,
    allows:          (name) => policy.allows(name),
    tools,
    permission,
    permCtx,
    hooks,
    toolCtx,
    buildAsk:        deps.buildAsk,
    runner:          resolvedRunner,
    pushEv:          toolEmit,
    signal:          signal_,
    toolResultStore: contextStores?.toolResultStore,
  });

  try {
    emotion.beginTurn(sessionId);
    clearTodos(sessionId);

    // ── onTurnStart hook ──────────────────────────────────────────────────────
    const startResult = await hooks.trigger('onTurnStart', {
      turnId, sessionId,
      payload: { mode: 'agent', subMode },
      meta: {},
    });
    if (startResult.kind === 'abort') {
      session.failTurn(turnId, 'turn/hook_aborted', startResult.reason);
      yield { type: 'turn_failed', sessionId, turnId, code: 'turn/hook_aborted', message: startResult.reason };
      return;
    }

    yield { type: 'turn_started', sessionId, turnId, mode: 'agent', agentSubMode: subMode };

    // ── Build initial message history ─────────────────────────────────────────
    const history = session.loadHistory(sessionId);
    // userInput is already string | LlmContentPart[] — no further unpacking needed.
    const userBlocks = userInput;

    session.appendMessage({
      turnId, sessionId, role: 'user',
      blocks: userBlocks as MessageBlocks,
    });

    // Conversation history for the LLM. The caller-provided systemPrompt is
    // prepended as a sensible default — the prompts:buildSystem hook (priority
    // 10) will REPLACE it in-place when registered. Embedders without that
    // hook (tests, minimal hosts) still get a working system message.
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...historyToLlmMessages(history),
      { role: 'user', content: userBlocks as string | UserBlock[] },
    ];

    // ── beforeLlm hook (initial) ──────────────────────────────────────────────
    const preLlm = await hooks.trigger('beforeLlm', {
      turnId, sessionId,
      payload: { systemPrompt, messages },
      meta: { mode: 'agent', subMode, userInput, signal, providerId, model, workspaceRoots },
    });
    if (preLlm.kind === 'abort') {
      session.failTurn(turnId, 'turn/hook_aborted', preLlm.reason);
      yield { type: 'turn_failed', sessionId, turnId, code: 'turn/hook_aborted', message: preLlm.reason };
      return;
    }
    // Splice hook-updated messages in-place (e.g. memory recall injected by a hook)
    messages.splice(0, messages.length, ...preLlm.payload.messages);

    // ── think→act loop ────────────────────────────────────────────────────────
    while (true) {
      if (signal.aborted) break;

      iterations++;
      yield { type: 'agent_iteration', sessionId, n: iterations };
      executor.reset();

      // ── THINK: stream one LLM response ─────────────────────────────────────
      // All three maps are keyed by blockIndex so the final assembly honours
      // the exact interleaving order the model produced.
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
        // Drain any tool events that arrived since the last chunk.
        // Tools may already be executing concurrently (started by prior tool_use_complete).
        while (pendingToolEvents.length > 0) yield pendingToolEvents.shift()!;

        switch (chunk.type) {
          case 'text_delta': {
            const { cleaned, events } = emotion.processChunk(chunk.delta, turnId, sessionId);
            if (cleaned) {
              textByIndex.set(chunk.blockIndex, (textByIndex.get(chunk.blockIndex) ?? '') + cleaned);
              yield { type: 'output_text_delta', sessionId, blockIndex: chunk.blockIndex, delta: cleaned };
            }
            for (const ev of events) yield ev;
            break;
          }

          case 'thinking_delta':
            thinkingByIndex.set(chunk.blockIndex, (thinkingByIndex.get(chunk.blockIndex) ?? '') + chunk.delta);
            yield { type: 'reasoning_delta', sessionId, blockIndex: chunk.blockIndex, delta: chunk.delta };
            break;

          case 'tool_use_delta':
            yield {
              type: 'tool_call_partial',
              sessionId,
              blockIndex: chunk.blockIndex,
              callId: chunk.callId, name: chunk.name, argsDelta: chunk.argsDelta,
            };
            break;

          case 'tool_use_complete':
            // Record for blockMap assembly
            toolUseByIndex.set(chunk.blockIndex, {
              type: 'tool_use', id: chunk.callId, name: chunk.name, args: chunk.args,
            });
            yield {
              type: 'tool_call_complete',
              sessionId,
              blockIndex: chunk.blockIndex,
              callId: chunk.callId, name: chunk.name, args: chunk.args,
            };
            // ── START EXECUTING IMMEDIATELY ────────────────────────────────
            // Don't wait for the rest of the LLM stream. Concurrent-safe tools
            // run in parallel; non-concurrent tools queue behind a serial fence.
            executor.addTool(chunk.blockIndex, chunk.callId, chunk.name, chunk.args);
            break;

          case 'usage':
            totalInput  += chunk.inputTokens;
            totalOutput += chunk.outputTokens;
            break;
        }
      }

      // Flush emotion scanner tail (handles partial ACT tags at end of stream).
      // Use the actual blockIndex for text: OpenAI always emits text at 1 (so
      // thinking 0 < text 1 < tools 1000+), Anthropic without thinking uses 0.
      // Reading from textByIndex avoids hardcoding adapter-specific constants.
      const { cleaned: tail } = emotion.flush(turnId, sessionId);
      if (tail) {
        const textIdx = textByIndex.size > 0 ? Math.min(...textByIndex.keys()) : 0;
        textByIndex.set(textIdx, (textByIndex.get(textIdx) ?? '') + tail);
        yield { type: 'output_text_delta', sessionId, blockIndex: textIdx, delta: tail };
      }

      // Reconstruct full text from indexed buffers
      const fullText = [...textByIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, t]) => t)
        .join('');

      // Persist the original block order for UI/debug history. Replay into the
      // next LLM request is handled by historyToLlmMessages(), which deliberately
      // filters thinking/tool blocks out for provider safety.
      const blockMap = new Map<number, AssistantBlock>();
      for (const [idx, text]    of textByIndex)     blockMap.set(idx, { type: 'text', text });
      for (const [idx, thinking] of thinkingByIndex) blockMap.set(idx, { type: 'thinking', thinking });
      for (const [idx, b]        of toolUseByIndex)  blockMap.set(idx, b);
      const allBlocks = [...blockMap.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);

      await hooks.trigger('afterLlmComplete', {
        turnId, sessionId,
        payload: { content: fullText, toolCalls: [...toolUseByIndex.values()] },
        meta: {},
      });

      // ── End condition: no tool calls registered this iteration ─────────────
      // Sole criterion: did the model actually emit any tool_use blocks?
      // Ignoring stopReason avoids provider inconsistencies where finish_reason='stop'
      // arrives alongside tool calls (DeepSeek, some compat providers).
      if (toolUseByIndex.size === 0) {
        // Drain any tool events that slipped in during the final hook await
        while (pendingToolEvents.length > 0) yield pendingToolEvents.shift()!;

        const msg = session.appendMessage({
          turnId, sessionId, role: 'assistant',
          blocks: allBlocks as MessageBlocks,
        });
        await hooks.trigger('afterMessage', {
          turnId, sessionId,
          payload: { messageId: msg.id, role: 'assistant', content: fullText },
          meta: {},
        });
        break;
      }

      // ── ACT: drain tool events and wait for all tools to complete ───────────
      // Tools were already started by executor.addTool() during the LLM stream.
      // Here we just wait for the remaining ones and collect results.
      while (!executor.allDone() || pendingToolEvents.length > 0) {
        // Yield events as they arrive (tool results, permission dialogs, progress)
        while (pendingToolEvents.length > 0) yield pendingToolEvents.shift()!;
        if (executor.allDone()) break;

        // Park until a tool pushes an event or signals completion.
        // Install the resolver FIRST, then re-check: the last tool can finish
        // between the allDone() check above and the assignment — its signal_()
        // would hit a null wakeUp and the loop would park forever (TOCTOU
        // deadlock, no logs, session stuck until restart).
        const parked = new Promise<void>(r => { wakeUp = r; });
        if (executor.allDone() || pendingToolEvents.length > 0) {
          wakeUp = null;   // state changed during installation — cancel the park
          continue;
        }
        await parked;
      }

      const resultBlocks: ToolResultBlock[] = executor.getResults();

      // Persist mid-loop assistant turn (has tool_use blocks) and inject results
      session.appendMessage({
        turnId, sessionId, role: 'assistant',
        blocks: allBlocks as MessageBlocks,
      });
      const replayBlocks = allBlocks.filter(b => b.type !== 'thinking');
      messages.push({ role: 'assistant', content: replayBlocks });

      session.appendMessage({
        turnId, sessionId, role: 'user',
        kind:   'tool_results',
        blocks: resultBlocks as MessageBlocks,
      });
      messages.push({ role: 'user', content: resultBlocks });

      // ── Circuit breaker ─────────────────────────────────────────────────────
      if (iterations >= policy.maxIterations()) {
        yield { type: 'agent_breaker_tripped', sessionId, reason: `max iterations (${policy.maxIterations()}) reached` };
        break;
      }
    }

    // ── Turn teardown ─────────────────────────────────────────────────────────
    // Abort has TWO routes into teardown: mid-stream (llm.stream throws
    // AbortError → catch below) and between iterations (the `if
    // (signal.aborted) break` at the loop head). The second route used to
    // fall through to completeTurn — a user-stopped turn was persisted as
    // 'completed', onTurnAbort never fired, and memory extraction ingested
    // the half-finished turn as a normal one. Branch here so both routes
    // produce identical abort semantics.
    if (signal.aborted) {
      await hooks.trigger('onTurnAbort', {
        turnId, sessionId,
        payload: { reason: 'user_stop' },
        meta: {},
      });
      session.abortTurn(sessionId, turnId);
      yield { type: 'turn_aborted', sessionId, turnId, reason: 'user_stop' };
      return;
    }

    const durationMs = Date.now() - startedAt;
    await hooks.trigger('onTurnEnd', {
      turnId, sessionId,
      payload: { durationMs },
      meta: {},
    });

    session.completeTurn(turnId, {
      usageInputTokens:  totalInput,
      usageOutputTokens: totalOutput,
      iterations,
    });
    yield {
      type: 'turn_completed', sessionId, turnId,
      stats: { inputTokens: totalInput, outputTokens: totalOutput, costUsd: 0, durationMs },
    };

  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (signal.aborted) {
      await hooks.trigger('onTurnAbort', {
        turnId, sessionId,
        payload: { reason: 'user_stop' },
        meta: {},
      });
      session.abortTurn(sessionId, turnId);
      yield { type: 'turn_aborted', sessionId, turnId, reason: 'user_stop' };
    } else {
      session.failTurn(turnId, 'provider/server_error', reason);
      yield { type: 'turn_failed', sessionId, turnId, code: 'provider/server_error', message: reason };
    }
  }
}

// historyToLlmMessages is shared with ConversationEngine — defined in @ema-agent/session.

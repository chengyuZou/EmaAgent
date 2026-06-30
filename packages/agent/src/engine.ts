import type { EmaStreamEvent, LlmMessage, AssistantBlock, UserBlock } from '@ema-agent/contracts';
import type { MessageBlocks } from '@ema-agent/session';
import type { ToolExecutionContext, ReadFileState } from '@ema-agent/tools';
import type { PermissionContext } from '@ema-agent/permission';
import type { AgentDeps, AgentRunInput } from './types.js';
import { AgentPolicy } from './policy.js';
import { TurnToolExecutor } from './tool-executor.js';
import { agentLoop, type ExecutorFactory } from './loop.js';
import { SubagentSpawner } from './spawner.js';
import { historyToLlmMessages } from '@ema-agent/session';
import { clearTodos } from '@ema-agent/tool-builtin';
import { buildScratchpadContext } from './scratchpad-context.js';
import * as fs   from 'node:fs';
import * as path from 'node:path';

// ── AgentEngine ───────────────────────────────────────────────────────────────

/**
 * Thin wrapper around agentLoop().  Handles session lifecycle, hooks, emotion
 * post-processing, session DB persistence, and SSE event translation.
 *
 * The pure think→act loop lives in loop.ts; spawner.ts handles sub-agents.
 * This class owns: hook triggers, emotion.processChunk / flush, session
 * DB persistence, taskStore transitions, and the ExecutorFactory that wires
 * the loop's internal relay callbacks to TurnToolExecutor.
 */
export class AgentEngine {
  // turnId → spawner, for per-subagent cancellation from the route layer.
  private readonly activeSpawners  = new Map<string, SubagentSpawner>();
  // turnId → executor, for per-tool cancellation from the route layer.
  private readonly activeExecutors = new Map<string, TurnToolExecutor>();

  constructor(private readonly deps: AgentDeps) {}

  run(input: AgentRunInput): AsyncIterable<EmaStreamEvent> {
    return runTurn(this.deps, input, this.activeSpawners, this.activeExecutors);
  }

  /** Cancel a single sub-agent without aborting the parent turn. */
  abortSubagent(turnId: string, subagentId: string): void {
    this.activeSpawners.get(turnId)?.abortSubagent(subagentId);
  }

  /** Cancel a single in-flight tool without aborting the parent turn. Returns false if not found. */
  abortTool(turnId: string, callId: string): boolean {
    return this.activeExecutors.get(turnId)?.abortTool(callId) ?? false;
  }
}

// ── Core turn runner ──────────────────────────────────────────────────────────

async function* runTurn(
  deps:            AgentDeps,
  input:           AgentRunInput,
  activeSpawners:  Map<string, SubagentSpawner>,
  activeExecutors: Map<string, TurnToolExecutor>,
): AsyncIterable<EmaStreamEvent> {
  const { session, hooks, llm, emotion, tools, permission, askUserRegistry } = deps;
  const { turn, signal, userInput, systemPrompt, workspaceRoots, providerId, model } = input;
  const sessionId = turn.sessionId;
  const turnId    = turn.id;
  const startedAt = Date.now();

  const policy        = new AgentPolicy(tools.list());
  const readFileState = new Map() as ReadFileState;
  const contextStores = deps.getContextStores?.(sessionId);
  const permCtx: PermissionContext = { workspaceRoots, sessionId };
  const resolvedRunner = deps.getCommandRunner?.(sessionId);

  // Turn-scoped scratchpad: shared between main agent and all sub-agents.
  // Created on demand by scratchpad_write; deleted in the finally block.
  const scratchpadDir = deps.dataDir
    ? path.join(deps.dataDir, 'sessions', sessionId, 'scratchpad', turnId)
    : undefined;

  // Per-iteration accumulators — reset on each loop_iteration event.
  let iterTextByIndex     = new Map<number, string>();
  let iterThinkingByIndex = new Map<number, string>();
  let iterToolCalls       = new Map<number, AssistantBlock & { type: 'tool_use' }>();
  let totalInput  = 0;
  let totalOutput = 0;
  let iterations  = 0;

  // Declared before try so finally can clear it. emitRef is filled in by
  // buildExecutor (inside the loop) and cleared in finally to cut the reference
  // chain to pendingRelayEvents before the spawner is released.
  const emitRef: { fn?: (ev: EmaStreamEvent) => void } = {};

  try {
    emotion.beginTurn(sessionId);
    clearTodos(turnId);

    // ── onTurnStart ───────────────────────────────────────────────────────────
    const startResult = await hooks.trigger('onTurnStart', {
      turnId, sessionId,
      payload: { mode: 'agent' },
      meta: {},
    });
    if (startResult.kind === 'abort') {
      session.failTurn(turnId, 'turn/hook_aborted', startResult.reason);
      yield { type: 'turn_failed', sessionId, turnId, code: 'turn/hook_aborted', message: startResult.reason };
      return;
    }

    yield { type: 'turn_started', sessionId, turnId, mode: 'agent' };

    // ── Build initial message history ─────────────────────────────────────────
    const history = session.loadHistory(sessionId);
    session.appendMessage({
      turnId, sessionId, role: 'user',
      blocks: userInput as MessageBlocks,
    });

    // messages is declared here so the spawner and executor factory can both
    // close over the same reference. The loop appends to this array each round.
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...historyToLlmMessages(history),
      { role: 'user', content: userInput as string | UserBlock[] },
    ];

    // ── beforeLlm hook ────────────────────────────────────────────────────────
    const preLlm = await hooks.trigger('beforeLlm', {
      turnId, sessionId,
      payload: { systemPrompt, messages },
      meta: { mode: 'agent', userInput, signal, providerId, model, workspaceRoots },
    });
    if (preLlm.kind === 'abort') {
      session.failTurn(turnId, 'turn/hook_aborted', preLlm.reason);
      yield { type: 'turn_failed', sessionId, turnId, code: 'turn/hook_aborted', message: preLlm.reason };
      return;
    }
    messages.splice(0, messages.length, ...preLlm.payload.messages);

    // ── Spawner + ExecutorFactory ─────────────────────────────────────────────
    // Both close over the same messages[] reference. Spawner snapshots it at
    // spawn() time (fork semantics). Factory is called once by agentLoop().
    //
    // emitRef lets the spawner forward subagent_progress to the parent SSE stream.
    // The ref is filled in by buildExecutor (called by agentLoop before any tools
    // run), so spawn() always sees a populated emitter.
    // (emitRef is declared before try{} so finally can clear it on turn end.)

    const spawner = new SubagentSpawner(
      deps, sessionId, turnId, providerId, model, messages,
      scratchpadDir,
      scratchpadDir ? () => buildScratchpadContext(scratchpadDir) : undefined,
      (ev) => emitRef.fn?.(ev),
    );
    activeSpawners.set(turnId, spawner);

    const buildExecutor: ExecutorFactory = ({ pushEv, signal: wakeSignal }) => {
      emitRef.fn = pushEv;   // wire parent SSE emitter now that the loop has started
      const toolCtx: ToolExecutionContext = {
        sessionId, turnId, workspaceRoots, signal, readFileState,
        fileStateStore:  contextStores?.fileStateStore,
        emit:            pushEv,
        commandRunner:   resolvedRunner,
        artifactStore:   deps.artifactStore,
        mcpClient:       deps.mcpClient,
        skillRunner:     deps.skillRunner,
        kbSearch:        deps.kbSearch
          ? (query, topK, kbIds) => {
              // Tool-supplied kbIds = explicit LLM override; pass assetScopes only for user selection.
              const effectiveKbIds  = kbIds ?? (input.kbIds?.length ? input.kbIds : []);
              const effectiveScopes = kbIds ? undefined : input.kbAssetScopes;
              return deps.kbSearch!(query, topK, effectiveKbIds, effectiveScopes, sessionId, turnId);
            }
          : undefined,
        subagentSpawner: spawner,
        scratchpadDir,
        scratchpadAuthor: 'main',
        askUser: askUserRegistry
          ? async (promptId, _questions) => {
              const { promise } = askUserRegistry.createWithId(promptId, undefined, turnId as string);
              return { answers: await promise };
            }
          : undefined,
      };

      const executor = new TurnToolExecutor({
        sessionId, turnId,
        allows:          name => policy.allows(name),
        tools, permission, permCtx, hooks, toolCtx,
        buildAsk:        deps.buildAsk,
        runner:          resolvedRunner,
        pushEv,
        signal:          wakeSignal,
        toolResultStore: contextStores?.toolResultStore,
      });
      activeExecutors.set(turnId, executor);
      return executor;
    };

    // ── taskStore: claim turn ────────────────────────────────────────────────
    if (deps.taskStore) {
      deps.taskStore.claim({
        taskId: turnId, sessionId, turnId, parentId: null,
      });
    }

    // ── Main loop — translate AgentLoopEvent → EmaStreamEvent ────────────────
    for await (const ev of agentLoop({
      messages, policy, buildExecutor, llm,
      providerId, model, signal,
      maxIterations: policy.maxIterations(),
      sessionId,
      getScratchpadContext: scratchpadDir
        ? () => buildScratchpadContext(scratchpadDir)
        : undefined,
      compactMessages: input.compactMessages,
      thinking:        input.thinking,
    })) {
      switch (ev.type) {

        case 'loop_iteration':
          iterations          = ev.n;
          iterTextByIndex     = new Map();
          iterThinkingByIndex = new Map();
          iterToolCalls       = new Map();
          yield { type: 'agent_iteration', sessionId, n: ev.n };
          break;

        case 'loop_text_delta': {
          const { cleaned, events } = emotion.processChunk(ev.delta, turnId, sessionId);
          if (cleaned) {
            iterTextByIndex.set(ev.blockIndex, (iterTextByIndex.get(ev.blockIndex) ?? '') + cleaned);
            yield { type: 'output_text_delta', sessionId, blockIndex: ev.blockIndex, delta: cleaned };
          }
          for (const e of events) yield e;
          break;
        }

        case 'loop_thinking_delta':
          iterThinkingByIndex.set(ev.blockIndex, (iterThinkingByIndex.get(ev.blockIndex) ?? '') + ev.delta);
          yield { type: 'reasoning_delta', sessionId, blockIndex: ev.blockIndex, delta: ev.delta };
          break;

        case 'loop_tool_partial':
          yield {
            type: 'tool_call_partial', sessionId,
            blockIndex: ev.blockIndex, callId: ev.callId, name: ev.name, argsDelta: ev.argsDelta,
          };
          break;

        case 'loop_tool_complete':
          iterToolCalls.set(ev.blockIndex, { type: 'tool_use', id: ev.callId, name: ev.name, args: ev.args });
          yield {
            type: 'tool_call_complete', sessionId,
            blockIndex: ev.blockIndex, callId: ev.callId, name: ev.name, args: ev.args,
          };
          break;

        case 'loop_relay':
          yield ev.ev;
          break;

        case 'loop_llm_complete': {
          // Flush emotion scanner tail (handles partial ACT tags at stream end).
          const { cleaned: tail } = emotion.flush(turnId, sessionId);
          if (tail) {
            const textIdx = iterTextByIndex.size > 0 ? Math.min(...iterTextByIndex.keys()) : 0;
            iterTextByIndex.set(textIdx, (iterTextByIndex.get(textIdx) ?? '') + tail);
            yield { type: 'output_text_delta', sessionId, blockIndex: textIdx, delta: tail };
          }

          const fullText = [...iterTextByIndex.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, t]) => t)
            .join('');

          await hooks.trigger('afterLlmComplete', {
            turnId, sessionId,
            payload: { content: fullText, toolCalls: [...iterToolCalls.values()] },
            meta: {},
          });
          break;
        }

        case 'loop_tool_results': {
          // Persist mid-loop assistant message (with tool_use blocks) + tool results.
          const blockMap = new Map<number, AssistantBlock>();
          for (const [idx, text]     of iterTextByIndex)     blockMap.set(idx, { type: 'text', text });
          for (const [idx, thinking] of iterThinkingByIndex) blockMap.set(idx, { type: 'thinking', thinking });
          for (const [idx, b]        of iterToolCalls)       blockMap.set(idx, b);
          const allBlocks = [...blockMap.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);

          session.appendMessage({ turnId, sessionId, role: 'assistant', blocks: allBlocks as MessageBlocks });
          session.appendMessage({ turnId, sessionId, role: 'user', kind: 'tool_results', blocks: ev.results as MessageBlocks });
          break;
        }

        case 'loop_breaker':
          yield { type: 'agent_breaker_tripped', sessionId, reason: ev.reason };
          break;

        case 'loop_done': {
          totalInput  = ev.state.usage.inputTokens;
          totalOutput = ev.state.usage.outputTokens;

          if (ev.state.transition === 'no_tool_calls') {
            // Final iteration had no tool calls — persist assistant message + hook.
            const blockMap = new Map<number, AssistantBlock>();
            for (const [idx, text]     of iterTextByIndex)     blockMap.set(idx, { type: 'text', text });
            for (const [idx, thinking] of iterThinkingByIndex) blockMap.set(idx, { type: 'thinking', thinking });
            const allBlocks = [...blockMap.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);

            const msg = session.appendMessage({ turnId, sessionId, role: 'assistant', blocks: allBlocks as MessageBlocks });
            await hooks.trigger('afterMessage', {
              turnId, sessionId,
              payload: { messageId: msg.id, role: 'assistant', content: ev.fullText },
              meta: {},
            });
          }
          break;
        }
      }
    }

    // ── Turn teardown ─────────────────────────────────────────────────────────
    if (signal.aborted) {
      await hooks.trigger('onTurnAbort', { turnId, sessionId, payload: { reason: 'user_stop' }, meta: {} });
      session.abortTurn(sessionId, turnId);
      deps.taskStore?.cancel(turnId, 'user_abort');
      yield { type: 'turn_aborted', sessionId, turnId, reason: 'user_stop' };
      return;
    }

    const durationMs = Date.now() - startedAt;
    await hooks.trigger('onTurnEnd', { turnId, sessionId, payload: { durationMs }, meta: {} });

    session.completeTurn(turnId, {
      usageInputTokens:  totalInput,
      usageOutputTokens: totalOutput,
      iterations,
    });
    deps.taskStore?.complete(turnId, { iterations, inputTokens: totalInput, outputTokens: totalOutput });
    yield {
      type: 'turn_completed', sessionId, turnId,
      stats: { inputTokens: totalInput, outputTokens: totalOutput, durationMs },
    };

  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (signal.aborted) {
      await hooks.trigger('onTurnAbort', { turnId, sessionId, payload: { reason: 'user_stop' }, meta: {} });
      session.abortTurn(sessionId, turnId);
      deps.taskStore?.cancel(turnId, 'user_abort');
      yield { type: 'turn_aborted', sessionId, turnId, reason: 'user_stop' };
    } else {
      session.failTurn(turnId, 'provider/server_error', reason);
      deps.taskStore?.fail(turnId, reason);
      yield { type: 'turn_failed', sessionId, turnId, code: 'provider/server_error', message: reason };
    }
  } finally {
    // Cut the emitRef → pushEv → pendingRelayEvents reference chain before the
    // spawner is released. Background sub-agents that outlive their parent turn
    // (LLM forgot to call subagent_await) will call emit() which is now a no-op
    // instead of pushing into a GC'd array, preventing a silent memory leak.
    emitRef.fn = undefined;
    activeSpawners.delete(turnId);
    activeExecutors.delete(turnId);
    if (scratchpadDir) {
      try { fs.rmSync(scratchpadDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
    }
  }
}


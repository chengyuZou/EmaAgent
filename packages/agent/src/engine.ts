// 运行一次 Agent Turn，并协调模型、工具、权限、Hook 和结果保存。

import type { EmaStreamEvent, ErrorCode, LlmMessage, AssistantBlock, UserBlock } from '@ema-agent/contracts';
import type { MessageBlocks } from '@ema-agent/session';
import type { ToolExecutionContext, ReadFileState } from '@ema-agent/tools';
import type { PermissionContext } from '@ema-agent/permission';
import type { TurnFailurePhase } from '@ema-agent/hook';
import type { AgentDeps, AgentRunInput } from './types.js';
import { AgentPolicy } from './policy.js';
import { TurnToolExecutor } from './tool-executor.js';
import { agentLoop, type ExecutorFactory } from './loop.js';
import { SubagentSpawner } from './spawner.js';
import { historyToLlmMessages } from '@ema-agent/session';
import { clearTodos } from '@ema-agent/tool-builtin';
import { buildScratchpadContext } from './scratchpad-context.js';
import { llmProviderErrorCode } from '@ema-agent/llm';
import * as fs   from 'node:fs';
import { AgentBudgetExceededError, TurnBudget } from './turn-budget.js';
import { awaitAgentAnswer } from './ask-user-lifecycle.js';

// ── AgentEngine ───────────────────────────────────────────────────────────────

/**
 * Thin wrapper around agentLoop().  Handles session lifecycle, hooks, emotion
 * post-processing, session DB persistence, and SSE event translation.
 *
 * The pure think→act loop lives in loop.ts; spawner.ts handles sub-agents.
 * This class owns: hook triggers, emotion.processChunk / flush, session
 * DB persistence through the unified Turn lifecycle Facade, and the ExecutorFactory that wires
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
  const { session, turnLifecycle, hooks, llm, emotion, tools, permission, askUserRegistry } = deps;
  const { turn, signal, userInput, workspaceRoot, providerId, model } = input;
  const sessionId = turn.sessionId;
  const turnId    = turn.id;
  const startedAt = Date.now();

  const policy        = new AgentPolicy(tools.list());
  const budget        = new TurnBudget();
  const readFileState = new Map() as ReadFileState;
  const contextStores = deps.getContextStores?.(sessionId);
  const resolvedRunner = deps.getCommandRunner?.(sessionId);

  // Core 生成根目录，Agent 只消费并把它转换成显式权限能力。
  // 主 Agent 与子 Agent 共享该 Turn 目录；目录由 scratchpad_write 按需创建。
  const scratchpadDir = input.scratchpadDir;
  const permCtx: PermissionContext = {
    workspaceRoot,
    sessionId,
    turnId,
    internalPaths: scratchpadDir ? { turnScratchpad: scratchpadDir } : undefined,
  };

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
  const pendingHookEvents: EmaStreamEvent[] = [];
  const emitHookEvent = (event: EmaStreamEvent): void => {
    pendingHookEvents.push(event);
  };
  let activePhase: TurnFailurePhase = 'setup';
  let failureReported = false;
  let turnExecutor: TurnToolExecutor | undefined;
  let turnSpawner: SubagentSpawner | undefined;
  let spawnerStopped = false;
  const stopSpawner = async (reason: string): Promise<void> => {
    if (spawnerStopped) return;
    spawnerStopped = true;
    emitRef.fn = undefined;
    await turnSpawner?.shutdown(reason);
  };
  const reportFailure = async (
    code: ErrorCode,
    message: string,
    phase: TurnFailurePhase,
  ): Promise<void> => {
    if (failureReported) return;
    failureReported = true;
    turnLifecycle.fail({ turnId, code, message });
    await hooks.trigger('onTurnFailure', {
      turnId,
      sessionId,
      payload: { phase, code, message, durationMs: Date.now() - startedAt },
      emit: emitHookEvent,
    });
  };

  try {
    emotion.beginTurn(sessionId);
    clearTodos(turnId);

    // ── onTurnStart ───────────────────────────────────────────────────────────
    activePhase = 'hook';
    const startResult = await hooks.trigger('onTurnStart', {
      turnId, sessionId,
      payload: { mode: 'agent' },
      signal,
      emit: emitHookEvent,
    });
    while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
    if (startResult.kind === 'abort') {
      await reportFailure('turn/hook_aborted', startResult.reason, 'hook');
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
      yield { type: 'turn_failed', sessionId, turnId, code: 'turn/hook_aborted', message: startResult.reason };
      return;
    }

    yield { type: 'turn_started', sessionId, turnId, mode: 'agent' };

    for (const degradation of input.requestDegradations ?? []) {
      yield { type: 'request_degraded', sessionId, turnId, ...degradation };
    }

    // ── Build initial message history ─────────────────────────────────────────
    activePhase = 'provider';
    const history = session.loadHistory(sessionId);
    if (Array.isArray(userInput)) {
      llm.assertCurrentContentCompatible(providerId, model, userInput);
    }
    const historyView = llm.prepareHistoricalMessages(
      providerId,
      model,
      historyToLlmMessages(history),
    );
    if (historyView.actions.length > 0) {
      yield {
        type: 'request_degraded',
        sessionId,
        turnId,
        attempt: 1,
        reason: '历史消息包含当前模型不支持或能力未知的媒体，已创建只读兼容视图',
        removed: [...new Set(historyView.actions.map((action) => action.modality))],
        replacements: ['placeholder'],
      };
    }
    activePhase = 'persistence';
    session.appendMessage({
      turnId, sessionId, role: 'user',
      blocks: userInput as MessageBlocks,
    });

    // messages is declared here so the spawner and executor factory can both
    // close over the same reference. The loop appends to this array each round.
    const messages: LlmMessage[] = [
      ...historyView.messages,
      { role: 'user', content: userInput as string | UserBlock[] },
    ];

    // ── Spawner + ExecutorFactory ─────────────────────────────────────────────
    // Executor closes over Turn 运行时依赖；Spawner 持有最新一次 beforeLlm
    // 产生的完整请求视图，并在 spawn() 时按 fork 语义创建快照。
    //
    // emitRef lets the spawner forward subagent_progress to the parent SSE stream.
    // The ref is filled in by buildExecutor (called by agentLoop before any tools
    // run), so spawn() always sees a populated emitter.
    // (emitRef is declared before try{} so finally can clear it on turn end.)

    // beforeLlm 返回的是每次请求的临时视图，不能写回原始历史，否则下一轮
    // 会重复注入 Memory/Skill 等上下文。Spawner 需要继承完整视图，因此维护
    // 一个稳定数组引用，每次 prepare 完成后原地刷新。
    const subagentContextMessages: LlmMessage[] = [];
    const scopedKbSearch: ToolExecutionContext['kbSearch'] | undefined = deps.kbSearch
      ? (query, topK, kbIds) => {
          // Tool 指定 kbIds 时是显式覆盖；否则继承父 Turn 的用户选择范围。
          const effectiveKbIds = kbIds ?? (input.kbIds?.length ? input.kbIds : []);
          const effectiveScopes = kbIds ? undefined : input.kbAssetScopes;
          return deps.kbSearch!(
            query,
            topK,
            effectiveKbIds,
            effectiveScopes,
            sessionId,
            turnId,
          );
        }
      : undefined;

    const spawner = new SubagentSpawner(
      deps, sessionId, turnId, providerId, model, subagentContextMessages,
      scratchpadDir,
      scratchpadDir ? () => buildScratchpadContext(scratchpadDir) : undefined,
      (ev) => emitRef.fn?.(ev),
      scopedKbSearch,
      budget,
    );
    turnSpawner = spawner;
    activeSpawners.set(turnId, spawner);

    const buildExecutor: ExecutorFactory = ({ pushEv, signal: wakeSignal }) => {
      emitRef.fn = pushEv;   // wire parent SSE emitter now that the loop has started
      const toolCtx: ToolExecutionContext = {
        sessionId, turnId, workspaceRoot, signal, readFileState,
        fileStateStore:  contextStores?.fileStateStore,
        emit:            pushEv,
        commandRunner:   resolvedRunner,
        artifactStore:   deps.artifactStore,
        mcpClient:       deps.mcpClient,
        skillRunner:     deps.skillRunner,
        toolCapabilities: policy.capabilities(),
        kbSearch:        scopedKbSearch,
        subagentSpawner: spawner,
        scratchpadDir,
        scratchpadAuthor: 'main',
        askUser: askUserRegistry
          ? async (promptId, questions, request) => {
              return awaitAgentAnswer({
                taskId: turnId as string,
                promptId,
                questions,
                request,
                turnId: turnId as string,
                signal,
                registry: askUserRegistry,
                taskStore: deps.taskStore,
              });
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
        toolExecutionJournal: deps.toolExecutionJournal,
      });
      turnExecutor = executor;
      activeExecutors.set(turnId, executor);
      return executor;
    };

    // ── Main loop — translate AgentLoopEvent → EmaStreamEvent ────────────────
    activePhase = 'provider';
    for await (const ev of agentLoop({
      messages, policy, buildExecutor, llm,
      providerId, model, signal,
      maxIterations: policy.maxIterations(),
      budget,
      sessionId,
      turnId,
      getScratchpadContext: scratchpadDir
        ? () => buildScratchpadContext(scratchpadDir)
        : undefined,
      compactMessages: input.compactMessages,
      prepareLlmCall: async ({ iteration, llmCallId, messages: callMessages }) => {
        activePhase = 'hook';
        const result = await hooks.trigger('beforeLlm', {
          turnId, sessionId,
          payload: {
            iteration,
            llmCallId,
            messages: callMessages,
            mode: 'agent',
            userInput: readableUserInput(userInput),
            providerId,
            model,
            workspaceRoot,
          },
          signal,
          emit: emitHookEvent,
        });
        activePhase = 'provider';
        if (result.kind === 'abort') {
          return { kind: 'abort', reason: result.reason };
        }
        // 初始 Session 历史已建立兼容副本。Hook/Tool 新增内容来源不明确，
        // 不允许猜成历史后静默替换；LLM 请求准备器负责最终 fail-closed 门禁。
        const finalMessages = result.payload.messages;
        subagentContextMessages.splice(
          0,
          subagentContextMessages.length,
          ...finalMessages,
        );
        return { kind: 'continue', messages: finalMessages };
      },
      thinking:        input.thinking,
    })) {
      // prepareLlmCall 在 Loop 内运行，Hook 发出的诊断事件会先进入本地队列。
      // 在处理随后的 LLM/终态事件前排空，保证 SSE 生命周期顺序稳定。
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;

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

        case 'loop_usage':
          yield {
            type: 'usage_update',
            sessionId,
            turnId,
            inputTokens: ev.usage.inputTokens,
            outputTokens: ev.usage.outputTokens,
          };
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

          activePhase = 'hook';
          await hooks.trigger('afterLlmComplete', {
            turnId, sessionId,
            payload: {
              iteration: ev.iteration,
              llmCallId: ev.llmCallId,
              content: fullText,
              usage: ev.usage,
              promptPrefixHash: ev.promptPrefixHash,
              toolCalls: [...iterToolCalls.values()],
            },
            signal,
            emit: emitHookEvent,
          });
          activePhase = 'provider';
          while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
          break;
        }

        case 'loop_request_degraded':
          yield {
            type: 'request_degraded',
            sessionId,
            turnId,
            attempt: ev.attempt,
            reason: ev.reason,
            removed: ev.removed,
            replacements: ev.replacements,
          };
          break;

        case 'loop_hook_abort':
          await turnExecutor?.shutdown('hook_abort');
          await stopSpawner('parent_turn_failed');
          await reportFailure('turn/hook_aborted', ev.reason, 'hook');
          while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
          yield {
            type: 'turn_failed',
            sessionId,
            turnId,
            code: 'turn/hook_aborted',
            message: ev.reason,
          };
          return;

        case 'loop_tool_results': {
          // Persist mid-loop assistant message (with tool_use blocks) + tool results.
          activePhase = 'persistence';
          const blockMap = new Map<number, AssistantBlock>();
          for (const [idx, text]     of iterTextByIndex)     blockMap.set(idx, { type: 'text', text });
          for (const [idx, thinking] of iterThinkingByIndex) blockMap.set(idx, { type: 'thinking', thinking });
          for (const [idx, b]        of iterToolCalls)       blockMap.set(idx, b);
          const allBlocks = [...blockMap.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);

          session.appendMessage({ turnId, sessionId, role: 'assistant', blocks: allBlocks as MessageBlocks });
          session.appendMessage({ turnId, sessionId, role: 'user', kind: 'tool_results', blocks: ev.results as MessageBlocks });
          activePhase = 'provider';
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

            activePhase = 'persistence';
            const msg = session.appendMessage({ turnId, sessionId, role: 'assistant', blocks: allBlocks as MessageBlocks });
            activePhase = 'hook';
            await hooks.trigger('afterAssistantMessage', {
              turnId, sessionId,
              payload: { messageId: msg.id, blocks: allBlocks },
              signal,
              emit: emitHookEvent,
            });
            while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
            activePhase = 'provider';
          }
          break;
        }
      }
    }

    // ── Turn teardown ─────────────────────────────────────────────────────────
    if (signal.aborted) {
      await turnExecutor?.shutdown('user_abort');
      await stopSpawner('parent_turn_aborted');
      await hooks.trigger('onTurnAbort', {
        turnId, sessionId,
        payload: { reason: 'user_stop' },
        emit: emitHookEvent,
      });
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
      turnLifecycle.abort({ sessionId, turnId, reason: 'user_abort' });
      yield { type: 'turn_aborted', sessionId, turnId, reason: 'user_stop' };
      return;
    }

    await stopSpawner('parent_turn_completed');
    const durationMs = Date.now() - startedAt;
    activePhase = 'hook';
    await hooks.trigger('onTurnEnd', {
      turnId, sessionId,
      payload: { durationMs },
      signal,
      emit: emitHookEvent,
    });
    while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;

    activePhase = 'persistence';
    turnLifecycle.complete({
      turnId,
      iterations,
      inputTokens: totalInput,
      outputTokens: totalOutput,
    });
    yield {
      type: 'turn_completed', sessionId, turnId,
      stats: { inputTokens: totalInput, outputTokens: totalOutput, durationMs },
    };

  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Turn 终态必须晚于工具终态：先取消并等待，防止 failed/aborted 之后仍产生副作用。
    await turnExecutor?.shutdown(signal.aborted ? 'user_abort' : 'turn_failed');
    await stopSpawner(signal.aborted ? 'parent_turn_aborted' : 'parent_turn_failed');
    if (signal.aborted) {
      await hooks.trigger('onTurnAbort', {
        turnId, sessionId,
        payload: { reason: 'user_stop' },
        emit: emitHookEvent,
      });
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
      turnLifecycle.abort({ sessionId, turnId, reason: 'user_abort' });
      yield { type: 'turn_aborted', sessionId, turnId, reason: 'user_stop' };
    } else {
      const code: ErrorCode = err instanceof AgentBudgetExceededError
        ? err.code
        : activePhase === 'provider'
          ? llmProviderErrorCode(err)
          : 'turn/execution_failed';
      await reportFailure(code, reason, activePhase);
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
      yield { type: 'turn_failed', sessionId, turnId, code, message: reason };
    }
  } finally {
    // Cut the emitRef → pushEv → pendingRelayEvents reference chain before the
    // spawner is released. Background sub-agents that outlive their parent turn
    // (LLM forgot to call subagent_await) will call emit() which is now a no-op
    // instead of pushing into a GC'd array, preventing a silent memory leak.
    emitRef.fn = undefined;
    await stopSpawner('parent_turn_finished');
    activeSpawners.delete(turnId);
    activeExecutors.delete(turnId);
    clearTodos(turnId);
    if (scratchpadDir) {
      try { fs.rmSync(scratchpadDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
    }
  }
}

function readableUserInput(input: AgentRunInput['userInput']): string {
  if (typeof input === 'string') return input;
  return input
    .filter((part): part is Extract<(typeof input)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}


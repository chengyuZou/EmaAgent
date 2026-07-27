// 创建并执行一个根 Turn，协调模型循环、工具、Hook、持久化与唯一终态。

import type { TurnFailureCode } from '@ema-agent/turn';
import { asAgentRunId } from '@ema-agent/ids';
import type { MessageBlocks, Turn } from '@ema-agent/session';
import type { TurnFailurePhase } from '@ema-agent/hooks';
import type {
  TurnExecutionDeps,
  TurnExecutionEvent,
  TurnHandle,
  TurnInput,
  TurnOutcome,
  TurnPreparationContext,
  TurnStartCommand,
} from './types.js';
import {
  AgentBudgetExceededError,
  runAgentLoop,
  TurnBudget,
} from '@ema-agent/agent';
import { llmProviderErrorCode } from '@ema-agent/llm';
import type { AssistantBlock } from '@ema-agent/llm';
import * as fs   from 'node:fs';
import { TurnPreparationError } from './errors.js';
import {
  TurnEventChannel,
  TurnEventChannelClosedError,
} from './turnEventChannel.js';
import { TurnContextBuilder } from './turnContext.js';
import {
  TurnTools,
  TurnToolsBuilder,
  type TurnToolsShutdownReason,
} from './turnTools.js';

// ── TurnExecutor ─────────────────────────────────────────────────────────────

/**
 * 根 Turn 的执行边界，负责持久化、Hook、取消收口和协议事件。
 * Agent 的思考与行动迭代由 AgentLoop 完成。
 */
export class TurnExecutor {
  // 路由只定位本 Turn 的工具协作者，不再穿透其 Spawner 与执行器。
  private readonly activeTools = new Map<string, TurnTools>();

  constructor(
    private readonly deps: TurnExecutionDeps,
    private readonly contextBuilder: TurnContextBuilder,
    private readonly toolsBuilder: TurnToolsBuilder,
  ) {}

  /**
   * 同步创建 Turn 并立刻返回稳定句柄。输入准备和模型执行在内部启动；
   * 事件通道使用固定容量反压，不会因调用方迟迟不消费而无限积压。
   */
  start(command: TurnStartCommand): TurnHandle {
    const { turn, signal } = this.deps.session.startTurn({
      sessionId: command.sessionId,
      triggerType: command.triggerType,
      executionProfile: command.executionProfile,
      narrativePolicy: command.narrativePolicy,
      userInput: command.userInput,
    });
    const sessionId = turn.sessionId;
    const turnId = turn.id;
    const channel = new TurnEventChannel<TurnExecutionEvent>(() => {
      this.deps.session.requestAbort(sessionId);
    });

    let resolveCompletion!: (outcome: TurnOutcome) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<TurnOutcome>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // Core 迁移期只消费 events；先登记拒绝观察者，避免极端持久化故障形成
    // 未处理 Promise。调用方仍可 await 原 Promise 得到同一个 rejection。
    void completion.catch(() => undefined);

    void this.pumpTurn(
      command,
      { turn, signal },
      channel,
      resolveCompletion,
      rejectCompletion,
    );

    return Object.freeze({
      sessionId,
      turnId,
      events: channel,
      completion,
      abort: () => {
        this.deps.session.requestAbort(sessionId);
      },
    });
  }

  /** 只取消指定子 AgentRun，不中止父 Turn。 */
  abortAgentRun(turnId: string, agentRunId: string): void {
    this.activeTools.get(turnId)?.abortAgentRun(asAgentRunId(agentRunId));
  }

  /** 只取消指定工具调用；找不到时返回 false。 */
  abortTool(turnId: string, callId: string): boolean {
    return this.activeTools.get(turnId)?.abortTool(callId) ?? false;
  }

  private async pumpTurn(
    command: TurnStartCommand,
    started: TurnPreparationContext,
    channel: TurnEventChannel<TurnExecutionEvent>,
    resolveCompletion: (outcome: TurnOutcome) => void,
    rejectCompletion: (error: unknown) => void,
  ): Promise<void> {
    const { turn, signal } = started;
    let outcome: TurnOutcome | undefined;

    try {
      const input = await command.prepare(started);
      const events = executeTurn(
        this.deps,
        this.contextBuilder,
        this.toolsBuilder,
        input,
        turn,
        signal,
        this.activeTools,
      );

      for await (const event of events) {
        outcome = outcomeFromEvent(event) ?? outcome;
        await channel.push(event);
      }

      if (!outcome) {
        outcome = await this.finishUnexpectedExecution(
          turn,
          signal,
          channel,
        );
      }
      resolveCompletion(outcome);
      channel.finish();
    } catch (error) {
      if (outcome) {
        resolveCompletion(outcome);
        channel.finish();
        return;
      }

      try {
        outcome = await this.finishStartFailure(
          turn,
          signal,
          error,
          channel,
        );
        resolveCompletion(outcome);
        channel.finish();
      } catch (terminalError) {
        rejectCompletion(terminalError);
        channel.fail(terminalError);
      }
    } finally {
      this.deps.session.clearRunning(turn.sessionId);
    }
  }

  private async finishUnexpectedExecution(
    turn: Turn,
    signal: AbortSignal,
    channel: TurnEventChannel<TurnExecutionEvent>,
  ): Promise<TurnOutcome> {
    return this.finishStartFailure(
      turn,
      signal,
      new Error('Turn execution ended without a terminal outcome'),
      channel,
    );
  }

  private async finishStartFailure(
    turn: Turn,
    signal: AbortSignal,
    error: unknown,
    channel: TurnEventChannel<TurnExecutionEvent>,
  ): Promise<TurnOutcome> {
    const { sessionId, id: turnId } = turn;
    if (signal.aborted || error instanceof TurnEventChannelClosedError) {
      const hookEvents: TurnExecutionEvent[] = [];
      await this.deps.hooks.trigger('onTurnAbort', {
        turnId,
        sessionId,
        payload: { reason: 'user_stop' },
        emit: (event) => hookEvents.push(event),
      });
      for (const event of hookEvents) {
        await pushUnlessConsumerClosed(channel, event);
      }

      this.deps.session.abortTurn(sessionId, turnId);
      const outcome: TurnOutcome = {
        status: 'aborted',
        sessionId,
        turnId,
        reason: 'user_stop',
      };
      await pushUnlessConsumerClosed(channel, {
        type: 'turn_aborted',
        sessionId,
        turnId,
        reason: outcome.reason,
      });
      return outcome;
    }

    const code = error instanceof TurnPreparationError
      ? error.code
      : 'turn/setup_failed';
    const message = error instanceof Error ? error.message : String(error);
    this.deps.session.failTurn(turnId, code, message);

    const hookEvents: TurnExecutionEvent[] = [];
    await this.deps.hooks.trigger('onTurnFailure', {
      turnId,
      sessionId,
      payload: {
        phase: 'setup',
        code,
        message,
        durationMs: Date.now() - turn.startedAt,
      },
      emit: (event) => hookEvents.push(event),
    });
    for (const event of hookEvents) {
      await pushUnlessConsumerClosed(channel, event);
    }

    const outcome: TurnOutcome = {
      status: 'failed',
      sessionId,
      turnId,
      code,
      message,
    };
    await pushUnlessConsumerClosed(channel, {
      type: 'turn_failed',
      sessionId,
      turnId,
      code,
      message,
    });
    return outcome;
  }
}

function outcomeFromEvent(event: TurnExecutionEvent): TurnOutcome | undefined {
  switch (event.type) {
    case 'turn_completed':
      return {
        status: 'completed',
        sessionId: event.sessionId,
        turnId: event.turnId,
        stats: event.stats,
      };
    case 'turn_failed':
      return {
        status: 'failed',
        sessionId: event.sessionId,
        turnId: event.turnId,
        code: event.code,
        message: event.message,
      };
    case 'turn_aborted':
      return {
        status: 'aborted',
        sessionId: event.sessionId,
        turnId: event.turnId,
        reason: event.reason,
      };
    default:
      return undefined;
  }
}

async function pushUnlessConsumerClosed(
  channel: TurnEventChannel<TurnExecutionEvent>,
  event: TurnExecutionEvent,
): Promise<void> {
  try {
    await channel.push(event);
  } catch (error) {
    if (!(error instanceof TurnEventChannelClosedError)) throw error;
  }
}

// ── Turn 核心运行入口 ─────────────────────────────────────────────────────────

async function* executeTurn(
  deps:           TurnExecutionDeps,
  contextBuilder: TurnContextBuilder,
  toolsBuilder:   TurnToolsBuilder,
  input:          TurnInput,
  turn:           Turn,
  signal:         AbortSignal,
  activeTools:    Map<string, TurnTools>,
): AsyncIterable<TurnExecutionEvent> {
  const { session, hooks, llm, emotion } = deps;
  const { userInput, workspaceRoot } = input;
  const {
    providerId,
    model,
  } = input.model;
  const sessionId = turn.sessionId;
  const turnId    = turn.id;
  const startedAt = Date.now();

  const budget        = new TurnBudget();
  const scratchpadDir = input.scratchpadDir;

  // 每次收到 loop_iteration 都重置本轮累计内容。
  let iterTextByIndex     = new Map<number, string>();
  let iterThinkingByIndex = new Map<number, string>();
  let iterThinkingSignatures = new Map<number, string>();
  let iterToolCalls       = new Map<number, AssistantBlock & { type: 'tool_use' }>();
  let totalInput  = 0;
  let totalOutput = 0;
  let iterations  = 0;

  // Context 与 Tool 协作者都通过同一事件出口进入 AgentLoop relay。
  const emitRef: { fn?: (ev: TurnExecutionEvent) => void } = {};
  const pendingHookEvents: TurnExecutionEvent[] = [];
  const emitHookEvent = (event: TurnExecutionEvent): void => {
    pendingHookEvents.push(event);
  };
  let activePhase: TurnFailurePhase = 'setup';
  let failureReported = false;
  let turnTools: TurnTools | undefined;
  const stopTools = async (reason: TurnToolsShutdownReason): Promise<void> => {
    await turnTools?.shutdown(reason);
  };
  const reportFailure = async (
    code: TurnFailureCode,
    message: string,
    phase: TurnFailurePhase,
  ): Promise<void> => {
    if (failureReported) return;
    failureReported = true;
    session.failTurn(turnId, code, message);
    await hooks.trigger('onTurnFailure', {
      turnId,
      sessionId,
      payload: { phase, code, message, durationMs: Date.now() - startedAt },
      emit: emitHookEvent,
    });
  };

  try {
    emotion.beginTurn(sessionId);
    // ── Turn 启动 Hook ────────────────────────────────────────────────────────
    activePhase = 'hook';
    const startResult = await hooks.trigger('onTurnStart', {
      turnId, sessionId,
      payload: {
        executionProfile: turn.executionProfile,
        narrativePolicy: turn.narrativePolicy,
      },
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

    yield {
      type: 'turn_started',
      sessionId,
      turnId,
      executionProfile: turn.executionProfile,
      narrativePolicy: turn.narrativePolicy,
    };

    for (const degradation of input.requestDegradations ?? []) {
      yield { type: 'request_degraded', sessionId, turnId, ...degradation };
    }

    // ── 准备本轮模型上下文 ────────────────────────────────────────────────────
    activePhase = 'provider';
    const preparedContext = yield* streamOperation((emit) =>
      contextBuilder.prepare({
        turn,
        input,
        signal,
        emit,
      }));
    if (preparedContext.degradation) {
      yield {
        type: 'request_degraded',
        sessionId,
        turnId,
        ...preparedContext.degradation,
      };
    }

    activePhase = 'persistence';
    session.appendMessage({
      turnId, sessionId, role: 'user',
      blocks: input.persistedUserInput,
    });

    // 剧情检索块是 Session UI 的正式记录，但不会作为普通历史再次喂给模型。
    if (preparedContext.narrativeTimelines.length > 0) {
      activePhase = 'persistence';
      session.appendMessage({
        turnId,
        sessionId,
        role: 'user',
        kind: 'narrative_context',
        blocks: { timelines: [...preparedContext.narrativeTimelines] },
      });
    }

    // Spawner 与 Executor 工厂共享同一数组引用，循环会在每轮向其中追加消息。
    const messages = preparedContext.messages;
    const readableInput = preparedContext.readableUserInput;

    // 工具快照只建立一次；后续 Skill/Profile 只能在该快照上收窄能力。
    const toolsForTurn = toolsBuilder.prepare({
      turn,
      input,
      signal,
      budget,
    });
    turnTools = toolsForTurn;
    activeTools.set(turnId, turnTools);
    const policy = toolsForTurn.policy;

    // AgentLoop 不认识 SSE；本层把循环事件翻译为现有传输协议。
    activePhase = 'provider';
    const agentLoop = runAgentLoop<TurnExecutionEvent>({
      messages,
      policy,
      buildExecutor: (args) => {
        emitRef.fn = args.pushEv;
        return toolsForTurn.buildExecutor(args);
      },
      llm,
      historyMessageCount: preparedContext.historyMessageCount,
      providerId, model, signal,
      maxIterations: policy.maxIterations(),
      budget,
      sessionId,
      turnId,
      getScratchpadContext: scratchpadDir
        ? () => toolsForTurn.readScratchpadContext()
        : undefined,
      assembleContext: async ({
        history: compactableHistory,
        currentTurn,
        scratchpadContext,
        mailboxMessages,
        forceCompaction,
      }) => preparedContext.assemble({
        history: compactableHistory,
        currentTurn,
        scratchpadContext,
        mailboxMessages,
        activeSkills: toolsForTurn.activeSkills(),
        toolManifest: policy.visibleManifestSnapshot(),
        forceCompaction,
        emit: (event) => emitRef.fn?.(event),
      }),
      prepareLlmCall: async ({ iteration, llmCallId, messages: callMessages }) => {
        activePhase = 'hook';
        const result = await hooks.trigger('beforeLlm', {
          turnId, sessionId,
          payload: {
            iteration,
            llmCallId,
            messages: callMessages,
            executionProfile: turn.executionProfile,
            narrativePolicy: turn.narrativePolicy,
            userInput: readableInput,
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
        toolsForTurn.updateParentContext(finalMessages);
        return { kind: 'continue', messages: finalMessages };
      },
      thinking: input.thinking,
    });
    let loopStep = await agentLoop.next();
    while (!loopStep.done) {
      const ev = loopStep.value;
      // prepareLlmCall 在 Loop 内运行，Hook 发出的诊断事件会先进入本地队列。
      // 在处理随后的 LLM/终态事件前排空，保证 SSE 生命周期顺序稳定。
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;

      switch (ev.type) {

        case 'loop_iteration':
          iterations          = ev.n;
          iterTextByIndex     = new Map();
          iterThinkingByIndex = new Map();
          iterThinkingSignatures = new Map();
          iterToolCalls       = new Map();
          yield { type: 'agent_iteration', sessionId, turnId, n: ev.n };
          break;

        case 'loop_text_delta': {
          const { cleaned, events } = emotion.processChunk(ev.delta, turnId, sessionId);
          if (cleaned) {
            iterTextByIndex.set(ev.blockIndex, (iterTextByIndex.get(ev.blockIndex) ?? '') + cleaned);
            yield { type: 'output_text_delta', sessionId, turnId, blockIndex: ev.blockIndex, delta: cleaned };
          }
          for (const e of events) yield e;
          break;
        }

        case 'loop_thinking_delta':
          iterThinkingByIndex.set(ev.blockIndex, (iterThinkingByIndex.get(ev.blockIndex) ?? '') + ev.delta);
          yield { type: 'reasoning_delta', sessionId, turnId, blockIndex: ev.blockIndex, delta: ev.delta };
          break;

        case 'loop_thinking_complete':
          if (ev.signature) iterThinkingSignatures.set(ev.blockIndex, ev.signature);
          yield {
            type: 'reasoning_complete',
            sessionId,
            turnId,
            blockIndex: ev.blockIndex,
          };
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
          // 刷出情绪扫描器尾部，处理流结束时尚未闭合的 ACT 标签。
          const { cleaned: tail } = emotion.flush(turnId, sessionId);
          if (tail) {
            const textIdx = iterTextByIndex.size > 0 ? Math.min(...iterTextByIndex.keys()) : 0;
            iterTextByIndex.set(textIdx, (iterTextByIndex.get(textIdx) ?? '') + tail);
            yield { type: 'output_text_delta', sessionId, turnId, blockIndex: textIdx, delta: tail };
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
          await stopTools('hook_aborted');
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
          // 循环中途持久化包含 tool_use 的助手消息及对应工具结果。
          activePhase = 'persistence';
          const blockMap = new Map<number, AssistantBlock>();
          for (const [idx, text]     of iterTextByIndex)     blockMap.set(idx, { type: 'text', text });
          for (const [idx, thinking] of iterThinkingByIndex) {
            const signature = iterThinkingSignatures.get(idx);
            blockMap.set(idx, {
              type: 'thinking',
              thinking,
              ...(signature ? { signature } : {}),
            });
          }
          for (const [idx, b]        of iterToolCalls)       blockMap.set(idx, b);
          const allBlocks = [...blockMap.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);

          session.appendMessage({ turnId, sessionId, role: 'assistant', blocks: allBlocks as MessageBlocks });
          session.appendMessage({ turnId, sessionId, role: 'user', kind: 'tool_results', blocks: ev.results as MessageBlocks });
          activePhase = 'provider';
          break;
        }

        case 'loop_breaker':
          yield { type: 'agent_breaker_tripped', sessionId, turnId, reason: ev.reason };
          break;

      }
      loopStep = await agentLoop.next();
    }

    const loopOutcome = loopStep.value;
    totalInput = loopOutcome.state.usage.inputTokens;
    totalOutput = loopOutcome.state.usage.outputTokens;

    if (loopOutcome.state.transition === 'no_tool_calls') {
      // 最后一轮没有工具调用，直接持久化助手消息并触发 Hook。
      const blockMap = new Map<number, AssistantBlock>();
      for (const [idx, text] of iterTextByIndex) blockMap.set(idx, { type: 'text', text });
      for (const [idx, thinking] of iterThinkingByIndex) {
        const signature = iterThinkingSignatures.get(idx);
        blockMap.set(idx, {
          type: 'thinking',
          thinking,
          ...(signature ? { signature } : {}),
        });
      }
      const allBlocks = [...blockMap.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, block]) => block);

      activePhase = 'persistence';
      const message = session.appendMessage({
        turnId,
        sessionId,
        role: 'assistant',
        blocks: allBlocks as MessageBlocks,
      });
      activePhase = 'hook';
      await hooks.trigger('afterAssistantMessage', {
        turnId,
        sessionId,
        payload: { messageId: message.id, blocks: allBlocks },
        signal,
        emit: emitHookEvent,
      });
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
      activePhase = 'provider';
    }

    // ── Turn 收尾 ─────────────────────────────────────────────────────────────
    if (signal.aborted) {
      await stopTools('aborted');
      await hooks.trigger('onTurnAbort', {
        turnId, sessionId,
        payload: { reason: 'user_stop' },
        emit: emitHookEvent,
      });
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
      session.abortTurn(sessionId, turnId);
      yield { type: 'turn_aborted', sessionId, turnId, reason: 'user_stop' };
      return;
    }

    await stopTools('completed');
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
    session.completeTurn(turnId, {
      iterations,
      usageInputTokens: totalInput,
      usageOutputTokens: totalOutput,
    });
    yield {
      type: 'turn_completed', sessionId, turnId,
      stats: { inputTokens: totalInput, outputTokens: totalOutput, durationMs },
    };

  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Turn 终态必须晚于工具终态：先取消并等待，防止 failed/aborted 之后仍产生副作用。
    await stopTools(signal.aborted ? 'aborted' : 'failed');
    if (signal.aborted) {
      await hooks.trigger('onTurnAbort', {
        turnId, sessionId,
        payload: { reason: 'user_stop' },
        emit: emitHookEvent,
      });
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
      session.abortTurn(sessionId, turnId);
      yield { type: 'turn_aborted', sessionId, turnId, reason: 'user_stop' };
    } else {
      const code: TurnFailureCode = err instanceof AgentBudgetExceededError
        ? err.code
        : activePhase === 'provider'
          ? llmProviderErrorCode(err)
          : 'turn/execution_failed';
      await reportFailure(code, reason, activePhase);
      while (pendingHookEvents.length > 0) yield pendingHookEvents.shift()!;
      yield { type: 'turn_failed', sessionId, turnId, code, message: reason };
    }
  } finally {
    // TurnTools 会在停止子 Agent 前切断内部事件引用；本层同步切断 Context relay。
    emitRef.fn = undefined;
    await stopTools('finished');
    activeTools.delete(turnId);
    if (scratchpadDir) {
      try { fs.rmSync(scratchpadDir, { recursive: true, force: true }); } catch { /* 清理失败不改变 Turn 终态 */ }
    }
  }
}

/**
 * 长耗时 Context 提供者执行期间立即转发领域事件，避免等全部召回完成后再成批刷新 UI。
 */
async function* streamOperation<T>(
  operation: (
    emit: (event: TurnExecutionEvent) => void,
  ) => Promise<T>,
): AsyncGenerator<TurnExecutionEvent, T> {
  const queue: TurnExecutionEvent[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let value!: T;
  let error: unknown;

  operation((event) => {
    queue.push(event);
    notify?.();
    notify = null;
  }).then(
    (result) => {
      value = result;
      done = true;
      notify?.();
      notify = null;
    },
    (reason: unknown) => {
      error = reason;
      done = true;
      notify?.();
      notify = null;
    },
  );

  while (!done || queue.length > 0) {
    while (queue.length > 0) yield queue.shift()!;
    if (!done) {
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }

  if (error !== undefined) throw error;
  return value;
}

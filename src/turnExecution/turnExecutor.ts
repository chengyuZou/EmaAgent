// 创建并执行一个根 Turn，协调模型循环、工具、Hook、持久化与唯一终态。

import type { TurnFailureCode } from '@ema-agent/turn';
import { asAgentRunId } from '@ema-agent/ids';
import type { MessageBlocks } from '@ema-agent/session';
import {
  ToolExecutionRuntime,
  type AskUserRequiredEvent,
  type ReadFileState,
} from '@ema-agent/tools';
import type { KnowledgeSearchPort } from '@ema-agent/knowledge';
import {
  assembleToolPool,
  type BuiltinToolContext,
} from '@ema-agent/tool-builtin';
import type { PermissionContext } from '@ema-agent/permission';
import type { TurnFailurePhase } from '@ema-agent/hooks';
import type {
  PreparedTurnExecution,
  TurnExecutionDeps,
  TurnExecutionEvent,
  TurnHandle,
  TurnOutcome,
  TurnStartCommand,
} from './types.js';
import {
  AgentBudgetExceededError,
  buildScratchpadContext,
  createToolLifecycleHooks,
  runAgentLoop,
  SubagentSpawner,
  TurnBudget,
  TurnPolicy,
  type ExecutorFactory,
} from '@ema-agent/agent';
import {
  buildModelMessages,
  buildRuntimeEnvironmentSnapshot,
  ContextAssembler,
  prepareHistoricalMessageView,
  validateCurrentContent,
} from '@ema-agent/context';
import type { ContextContribution } from '@ema-agent/context';
import { LlmModelCapabilityError, llmProviderErrorCode } from '@ema-agent/llm';
import type { AssistantBlock, Message as ModelMessage, UserBlock } from '@ema-agent/llm';
import * as fs   from 'node:fs';
import { awaitUserAnswer } from './awaitUserAnswer.js';
import {
  ActiveSkillState,
  renderActiveSkillContext,
} from '@ema-agent/skills';
import { TurnPreparationError } from './errors.js';
import {
  TurnEventChannel,
  TurnEventChannelClosedError,
} from './turnEventChannel.js';
import {
  NarrativeClientError,
  prepareNarrativeRecall,
  type NarrativeRecallResult,
} from '@ema-agent/narrative';
import { executionProfilePolicy } from './executionProfilePolicy.js';

// ── TurnExecutor ─────────────────────────────────────────────────────────────

/**
 * 根 Turn 的执行边界，负责持久化、Hook、取消收口和协议事件。
 * Agent 的思考与行动迭代由 AgentLoop 完成。
 */
export class TurnExecutor {
  // 路由按 turnId 定位 Spawner，以便只取消某个子 Agent。
  private readonly activeSpawners  = new Map<string, SubagentSpawner>();
  // 路由按 turnId 定位 Executor，以便只取消某个工具调用。
  private readonly activeExecutors = new Map<string, ToolExecutionRuntime>();

  constructor(private readonly deps: TurnExecutionDeps) {}

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
    this.activeSpawners.get(turnId)?.abortSubagent(asAgentRunId(agentRunId));
  }

  /** 只取消指定工具调用；找不到时返回 false。 */
  abortTool(turnId: string, callId: string): boolean {
    return this.activeExecutors.get(turnId)?.abortTool(callId) ?? false;
  }

  private async pumpTurn(
    command: TurnStartCommand,
    started: Pick<PreparedTurnExecution, 'turn' | 'signal'>,
    channel: TurnEventChannel<TurnExecutionEvent>,
    resolveCompletion: (outcome: TurnOutcome) => void,
    rejectCompletion: (error: unknown) => void,
  ): Promise<void> {
    const { turn, signal } = started;
    let outcome: TurnOutcome | undefined;

    try {
      const plan = await command.prepare(started);
      const events = executeTurn(
        this.deps,
        { ...plan, turn, signal },
        this.activeSpawners,
        this.activeExecutors,
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
    turn: PreparedTurnExecution['turn'],
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
    turn: PreparedTurnExecution['turn'],
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
  deps:            TurnExecutionDeps,
  input:           PreparedTurnExecution,
  activeSpawners:  Map<string, SubagentSpawner>,
  activeExecutors: Map<string, ToolExecutionRuntime>,
): AsyncIterable<TurnExecutionEvent> {
  const { session, hooks, llm, emotion, tools, permission, askUserInteraction } = deps;
  const { turn, signal, userInput, workspaceRoot, providerId, model } = input;
  const sessionId = turn.sessionId;
  const turnId    = turn.id;
  const startedAt = Date.now();

  const budget        = new TurnBudget();
  const readFileState = new Map() as ReadFileState;
  const toolResultStore = deps.getSessionToolResultStore?.(sessionId);
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

  // 每次收到 loop_iteration 都重置本轮累计内容。
  let iterTextByIndex     = new Map<number, string>();
  let iterThinkingByIndex = new Map<number, string>();
  let iterThinkingSignatures = new Map<number, string>();
  let iterToolCalls       = new Map<number, AssistantBlock & { type: 'tool_use' }>();
  let totalInput  = 0;
  let totalOutput = 0;
  let iterations  = 0;

  // 在 try 外声明，确保 finally 能在释放 Spawner 前切断事件队列引用。
  // buildExecutor 会在循环启动后填入实际发送函数。
  const emitRef: { fn?: (ev: TurnExecutionEvent) => void } = {};
  const pendingHookEvents: TurnExecutionEvent[] = [];
  const emitHookEvent = (event: TurnExecutionEvent): void => {
    pendingHookEvents.push(event);
  };
  let activePhase: TurnFailurePhase = 'setup';
  let failureReported = false;
  let turnExecutor: ToolExecutionRuntime | undefined;
  let turnSpawner: SubagentSpawner | undefined;
  let spawnerStopped = false;
  const stopSpawner = async (reason: string): Promise<void> => {
    if (spawnerStopped) return;
    spawnerStopped = true;
    emitRef.fn = undefined;
    await turnSpawner?.shutdown(reason);
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

    // ── 构建初始消息历史 ──────────────────────────────────────────────────────
    activePhase = 'provider';
    const history = session.loadHistory(sessionId);
    const capabilities = deps.modelCapabilities.resolve({ providerId, model });
    if (Array.isArray(userInput)) {
      const issues = validateCurrentContent(userInput, capabilities);
      if (issues.length > 0) {
        throw new LlmModelCapabilityError(providerId, model, issues);
      }
    }
    const historyView = prepareHistoricalMessageView(
      buildModelMessages(history),
      capabilities,
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
      blocks: input.persistedUserInput ?? userInput as MessageBlocks,
    });

    // Spawner 与 Executor 工厂共享同一数组引用，循环会在每轮向其中追加消息。
    const messages: ModelMessage[] = [
      ...historyView.messages,
      { role: 'user', content: userInput as string | UserBlock[] },
    ];
    const baseContributions: ContextContribution[] = [];
    let narrativeRecall: NarrativeRecallResult | undefined;

    // Narrative 是本轮 Context 的不可信资料来源，不经 Hook 改写消息数组。
    // V1 的 always 主动召回保留现有语义；auto 等 NarrativeSearch Tool 接线。
    const readableInput = readableUserInput(userInput);
    if (turn.narrativePolicy === 'always' && readableInput && deps.narrative) {
      activePhase = 'provider';
      try {
        narrativeRecall = yield* streamOperation((emit) =>
          prepareNarrativeRecall(deps.narrative!, {
            sessionId,
            turnId,
            userInput: readableInput,
            signal,
            emit,
          }));
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        if (!(error instanceof NarrativeClientError)) throw error;
        yield {
          type: 'narrative_recall_unavailable',
          sessionId,
          turnId,
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        };
      }

      if (narrativeRecall?.contextText) {
        baseContributions.push({
          id: 'narrative.recall',
          source: 'narrative',
          placement: 'beforeCurrentTurn',
          message: {
            role: 'user',
            content:
              '[NARRATIVE CONTEXT - do not quote verbatim; use as background]\n\n'
              + narrativeRecall.contextText,
          },
        });
      }
      if (
        narrativeRecall
        && narrativeRecall.timelines.length === 0
        && narrativeRecall.failedTimelineCount > 0
      ) {
        yield {
          type: 'narrative_recall_unavailable',
          sessionId,
          turnId,
          code: 'narrative/unknown',
          message: 'Narrative timelines unavailable - continuing without narrative context',
          retryable: true,
        };
      }
    }

    if (input.prepareContextContributions) {
      activePhase = 'unknown';
      const prepared = yield* streamOperation((emit) =>
        input.prepareContextContributions!({
          sessionId,
          turnId,
          executionProfile: turn.executionProfile,
          narrativePolicy: turn.narrativePolicy,
          userInput: readableInput,
          signal,
          emit,
        }));
      baseContributions.push(...prepared);
    }

    // 剧情检索块是 Session UI 的正式记录，但不会作为普通历史再次喂给模型。
    if (narrativeRecall && narrativeRecall.timelines.length > 0) {
      activePhase = 'persistence';
      session.appendMessage({
        turnId,
        sessionId,
        role: 'user',
        kind: 'narrative_context',
        blocks: { timelines: [...narrativeRecall.timelines] },
      });
    }
    const contextAssembler = new ContextAssembler();
    const activeSkillState = new ActiveSkillState();

    // ── 子 Agent 调度器与工具执行器工厂 ───────────────────────────────────────
    // 工具执行器闭包捕获 Turn 运行时依赖；Spawner 持有最新一次 beforeLlm
    // 产生的完整请求视图，并在 spawn() 时按 fork 语义创建快照。
    //
    // emitRef 让 Spawner 把子 Agent 进度转发到父 SSE 流。
    // AgentLoop 会在执行工具前调用 buildExecutor，因此 spawn 时发送函数已经就绪；
    // Turn 结束后由 finally 清空引用。

    // beforeLlm 返回的是每次请求的临时视图，不能写回原始历史，否则下一轮
    // 会重复注入 Memory/Skill 等上下文。Spawner 需要继承完整视图，因此维护
    // 一个稳定数组引用，每次 prepare 完成后原地刷新。
    const subagentContextMessages: ModelMessage[] = [];
    const scopedKbSearch: KnowledgeSearchPort | undefined = deps.kbSearch
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
      workspaceRoot,
      resolvedRunner,
      readFileState,
      scratchpadDir,
      scratchpadDir ? () => buildScratchpadContext(scratchpadDir) : undefined,
      (ev) => emitRef.fn?.(ev),
      scopedKbSearch,
      budget,
      activeSkillState,
    );
    turnSpawner = spawner;
    activeSpawners.set(turnId, spawner);

    // 先按本次根 Turn 真正拥有的能力装配模型可见工具，再从同一 Manifest
    // 建立执行策略。Tool 不可见与不可执行因此不会由两套手写门控分别决定。
    const capabilityContext: BuiltinToolContext = {
      sessionId,
      turnId,
      workspaceRoot,
      signal,
      readFileState,
      taskStore:         deps.taskStore,
      commandRunner:     resolvedRunner,
      artifactStore:     deps.artifactStore,
      skillRunner:       deps.skillRunner,
      activeSkillState,
      knowledgeSearch:   scopedKbSearch,
      subagentSpawner:   spawner,
      scratchpad:        scratchpadDir ? { dir: scratchpadDir, author: 'main' } : undefined,
      askUser: askUserInteraction
        ? async (promptId, questions, request) => {
            void questions;
            return awaitUserAnswer({
              promptId,
              request: request as AskUserRequiredEvent,
              turnId: turnId as string,
              signal,
              interaction: askUserInteraction,
            });
          }
        : undefined,
    };
    const profilePolicy = executionProfilePolicy(turn.executionProfile);
    const assembledTools = assembleToolPool(tools, capabilityContext);
    const profileTools = profilePolicy.allowedToolIds === null
      ? assembledTools
      : assembledTools.filter((tool) => profilePolicy.allowedToolIds!.has(tool.id));
    const policy = new TurnPolicy(
      tools.manifestSnapshot(profileTools),
      profilePolicy.maxIterations,
    );
    const toolContext: BuiltinToolContext = Object.freeze({
      ...capabilityContext,
      toolCapabilities: policy.capabilities(),
    });

    const buildExecutor: ExecutorFactory<TurnExecutionEvent> = ({ pushEv, signal: wakeSignal }) => {
      emitRef.fn = pushEv;   // 循环启动后接入父 SSE 发送函数

      const executor = new ToolExecutionRuntime({
        sessionId, turnId,
        allows:          name => policy.allows(name),
        toolManifest:    policy.manifestSnapshot(),
        tools, permission, permCtx, toolContext,
        lifecycle: createToolLifecycleHooks(hooks, pushEv),
        buildAsk:        deps.buildAsk,
        pushEv,
        signal:          wakeSignal,
        toolResultStore,
        toolExecutionJournal: deps.toolExecutionJournal,
      });
      turnExecutor = executor;
      activeExecutors.set(turnId, executor);
      return executor;
    };

    // AgentLoop 不认识 SSE；本层把循环事件翻译为现有传输协议。
    activePhase = 'provider';
    const agentLoop = runAgentLoop<TurnExecutionEvent>({
      messages, policy, buildExecutor, llm,
      historyMessageCount: historyView.messages.length,
      providerId, model, signal,
      maxIterations: policy.maxIterations(),
      budget,
      sessionId,
      turnId,
      getScratchpadContext: scratchpadDir
        ? () => buildScratchpadContext(scratchpadDir)
        : undefined,
      assembleContext: async ({
        history: compactableHistory,
        currentTurn,
        scratchpadContext,
        mailboxMessages,
        forceCompaction,
      }) => {
        const contributions: ContextContribution[] = [...baseContributions];
        const activeSkillContext = renderActiveSkillContext(activeSkillState.list());
        if (scratchpadContext) {
          contributions.push({
            id: 'scratchpad.current',
            source: 'scratchpad',
            placement: 'afterCurrentTurn',
            message: { role: 'user', content: scratchpadContext },
          });
        }
        mailboxMessages.forEach((content, index) => {
          contributions.push({
            id: `mailbox.${index}`,
            source: 'mailbox',
            placement: 'afterCurrentTurn',
            message: { role: 'user', content: `[Coordinator]: ${content}` },
          });
        });
        const assemblyInput = {
          prompt: input.prompt,
          environment: buildRuntimeEnvironmentSnapshot({
            providerId,
            model,
            workspaceRoot,
          }),
          history: compactableHistory,
          currentTurn,
          contributions,
          postCompactionRestoreContributions: activeSkillContext
            ? [{
                id: 'skills.active',
                source: 'skills' as const,
                placement: 'beforeCurrentTurn' as const,
                message: { role: 'user' as const, content: activeSkillContext },
              }]
            : [],
          toolManifest: policy.visibleManifestSnapshot(),
        };
        return input.compactContext
          ? contextAssembler.assembleCompacted(
              assemblyInput,
              input.compactContext,
              { force: forceCompaction },
            )
          : contextAssembler.assemble(assemblyInput);
      },
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
      await turnExecutor?.shutdown('user_abort');
      await stopSpawner('parent_turn_aborted');
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
    await turnExecutor?.shutdown(signal.aborted ? 'user_abort' : 'turn_failed');
    await stopSpawner(signal.aborted ? 'parent_turn_aborted' : 'parent_turn_failed');
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
    // 释放 Spawner 前切断 emitRef → pushEv → pendingRelayEvents 引用链。
    // 即使后台子 Agent 因模型未调用 subagent_await 而晚于父 Turn 结束，
    // 后续 emit 也只会空操作，不会继续向失去消费者的数组写入并造成内存泄漏。
    emitRef.fn = undefined;
    await stopSpawner('parent_turn_finished');
    activeSpawners.delete(turnId);
    activeExecutors.delete(turnId);
    if (scratchpadDir) {
      try { fs.rmSync(scratchpadDir, { recursive: true, force: true }); } catch { /* 清理失败不改变 Turn 终态 */ }
    }
  }
}

function readableUserInput(input: PreparedTurnExecution['userInput']): string {
  if (typeof input === 'string') return input;
  return input
    .filter((part): part is Extract<(typeof input)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
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

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return error instanceof Error && error.name === 'AbortError';
}

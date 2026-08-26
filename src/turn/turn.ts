// 根 Turn 的唯一公开执行入口：创建、驱动、唯一终态与取消。
import * as fs from 'node:fs';
import {
  readAgentSettings,
  runAgentLoop,
  type AgentLoopEvent,
} from '@ema-agent/agent';
import { resolveAttachmentReferences } from '@ema-agent/attachments';
import {
  appendEstimatedContextMessages,
  deriveLlmHistory,
  estimatedContextUsage,
  providerContextUsage,
  type ContextUsage,
  type ContextUsageEstimate,
} from '@ema-agent/context';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import type {
  CallLlm,
  LlmGenerationSource,
  Message,
} from '@ema-agent/llm';
import { isLlmProtocol } from '@ema-agent/providers';
import {
  collectAttachmentReferenceIds,
  type AttachmentReferenceBlock,
  type MessageBlocks,
  type SessionStore,
} from '@ema-agent/session';
import type { StageEngine } from '@ema-agent/stage';
import type { TurnFailureCode } from './errors.js';
import type { Turn } from './types.js';
import { recordLlmCallUsage, type UsageRecorder } from '@ema-agent/usage';
import {
  TurnEventChannel,
  TurnEventChannelClosedError,
} from './eventChannel.js';
import {
  failureCodeOf,
  failureMessageOf,
  TurnBudgetExceededError,
} from './errors.js';
import type { TurnStreamEvent } from './events.js';
import { createPrepareLlmCall } from './loop/prepareLlmCall.js';
import { createPrepareSubagent } from './loop/prepareSubagent.js';
import { TurnBudget } from './loop/turnBudget.js';
import { TurnMessageWriter } from './loop/turnMessageWriter.js';
import {
  prepareTurn,
  type PreparedTurn,
  type PrepareTurnDeps,
} from './preparation/prepareTurn.js';
import {
  renderTurnReminder,
  RenderTurnReminderInput,
} from './preparation/turnReminder.js';
import type { TurnToolsAssembly } from './preparation/prepareTurnTools.js';
import type { TurnStore } from './turnStore.js';
import type {
  StartTurn,
  TurnHandle,
  TurnOutcome,
} from './types.js';

/** 本包常量预算；工具/子 Agent 额度来自 agent 包 settings，时长与输出上限 V1 不做设置项。 */
const DEFAULT_MAX_DURATION_MS = 30 * 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 200_000;

/**
 * Reminder 事实的作用域：git/任务/scratchpad 等工作区与 Session 事实、Narrative 召回
 * 所需的用户输入、以及召回事件的 Turn 事件流出口，全部按 Turn 绑定。
 */
export interface TurnReminderScope {
  readonly sessionId: string;
  readonly turnId: string;
  readonly executionProfile: Turn['executionProfile'];
  /** auto = NarrativeSearchTool 可见；always = Turn 开头查询一次并写入 reminder；off = 两者皆无。 */
  readonly narrativePolicy: Turn['narrativePolicy'];
  /** 本 Turn 用户文本（附件降级后）；backgroundProcessCompleted 等触发可为空串。 */
  readonly userText: string;
  readonly emit: (event: TurnStreamEvent) => void;
}

export interface TurnExecutorDeps extends PrepareTurnDeps {
  readonly turns: TurnStore;
  readonly sessions: Pick<
    SessionStore,
    'getSession' | 'appendMessage' | 'appendHistorySummary' | 'loadHistory' | 'markMessageInterrupted' | 'updateMessageBlocks'
  >;
  readonly createCompact: (
    callLlm: CallLlm,
  ) => (request: CompactRequest) => Promise<CompactResult>;
  /**
   * 每根 Turn 调用一次，产出 reminder 的完整启动期输入（含 currentDate 等全部字段：
   * git 探测、Memory 摘要、Narrative always 召回、Task 一次性提醒、Scratchpad 快照）。
   * 结果即冻结，本 Turn 后续 LLM Call 复用同一份持久化 reminder，不再回读。
   */
  readonly readTurnReminder: (
    scope: TurnReminderScope,
  ) => Promise<RenderTurnReminderInput> | RenderTurnReminderInput;
  /**
   * Task 低频提醒在 reminder Message 成功持久化后提交"已提醒"；只有提醒确实送达
   * 才推进提醒周期，Turn 准备失败不吞掉周期。没有第二种提交行为，不做通用回调。
   */
  readonly onTaskReminderPersisted?: (sessionId: string) => void;
  /** 逐次 LLM 调用用量记录；缺省不记账（观测不阻断主链）。 */
  readonly usageRecorder?: UsageRecorder;
  /**
   * 角色舞台：text delta 在落库与发射前经它剥离表现标签（cleaned 是唯一持久化与
   * 发射形态），emotion_changed/stage_cue 随流发出。缺省时 delta 原样透传。
   */
  readonly stage?: StageEngine;
  /**
   * 用户消息落库后异步启动标题生成（内部自管读检/去重/条件写）；仅 userMessage
   * 触发的 Turn 调用。不阻塞 AgentLoop，结果与 Turn 终态无关。
   */
  readonly startSessionTitleGeneration?: (sessionId: string, userText: string) => void;
  /**
   * prepare 完成时读取当前激活角色的磁盘目录名（Character.directoryName），
   * 回填冻结到 Turn 行；与 characterPrompt 同一时点读取，保证同源。
   */
  readonly characterDirectoryName: () => string;
  /**
   * completed 终态的同事务登记口（Memory 提取入队）。在 completeTurn 的 SQL 事务内
   * 同步调用：只许入队类写入，禁止在此启动异步工作。Memory 零 import——由装配层注入。
   */
  readonly onTurnCompletedInTransaction?: (turnId: string) => void;
}

/**
 * TurnExecutor 持有跨 Turn 共享的协作者；每个 Turn 的通道、预算、工具层与
 * 事件翻译都在 start() 内按 Turn 创建。Route 只拿这个入口，不接触任何内部件。
 */
export class TurnExecutor {
  /** 活动 Turn 的工具层快照，供 abortTool/abortAgentRun 按 turnId 定位。 */
  private readonly runningTools = new Map<string, TurnToolsAssembly>();
  /** 活动 Turn 的 completion，供 abortAndAwait（Session 删除等编排）等待终态落库。 */
  private readonly runningCompletions = new Map<string, Promise<TurnOutcome>>();

  constructor(private readonly deps: TurnExecutorDeps) {}

  start(input: StartTurn): TurnHandle {
    const { turn, signal } = this.deps.turns.startTurn({
      turnId: input.turnId,
      sessionId: input.sessionId,
      triggerType: input.triggerType,
      executionProfile: input.executionProfile,
      narrativePolicy: input.narrativePolicy,
    });
    const channel = new TurnEventChannel<TurnStreamEvent>(() => {
      this.deps.turns.requestAbort(turn.sessionId, turn.id);
    });

    let resolveCompletion!: (outcome: TurnOutcome) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<TurnOutcome>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // Server 主要消费 events；预先观察 rejection，避免极端持久化故障形成未处理 Promise。
    void completion.catch(() => undefined);
    this.runningCompletions.set(turn.id, completion);

    void this.pumpTurn({
      input,
      turn,
      signal,
      channel,
      resolveCompletion,
      rejectCompletion,
    });

    return Object.freeze({
      sessionId: turn.sessionId,
      turnId: turn.id,
      events: channel,
      completion,
      abort: () => {
        this.deps.turns.requestAbort(turn.sessionId, turn.id);
      },
    });
  }

  /** 只取消当前仍活动的指定根 Turn；历史句柄不能误杀后继 Turn。 */
  abort(sessionId: string, turnId: string): boolean {
    const active = this.deps.turns.getActiveTurn(sessionId);
    if (active?.id !== turnId) return false;
    this.deps.turns.requestAbort(sessionId, turnId);
    return true;
  }

  /**
   * 取消并等待该 Turn 终态落库。Session 删除等编排必须先让活动 Turn 走完
   * finish 链（writer 收口、队列清理），否则删除会与在飞持久化竞争。
   */
  async abortAndAwait(sessionId: string, turnId: string): Promise<void> {
    this.abort(sessionId, turnId);
    await this.runningCompletions.get(turnId)?.catch(() => undefined);
  }

  abortTool(turnId: string, toolCallId: string): boolean {
    return this.runningTools.get(turnId)?.abortTool(toolCallId) ?? false;
  }

  abortAgentRun(turnId: string, agentRunId: string): boolean {
    return this.runningTools.get(turnId)?.abortAgentRun(agentRunId) ?? false;
  }

  private async pumpTurn(args: {
    input: StartTurn;
    turn: Turn;
    signal: AbortSignal;
    channel: TurnEventChannel<TurnStreamEvent>;
    resolveCompletion: (outcome: TurnOutcome) => void;
    rejectCompletion: (error: unknown) => void;
  }): Promise<void> {
    const { input, turn, signal, channel, resolveCompletion, rejectCompletion } = args;
    const { sessionId } = turn;
    const turnId = turn.id;
    const emit = (event: TurnStreamEvent): void => {
      void channel.push(event).catch(() => undefined);
    };

    const writer = new TurnMessageWriter(sessionId, turnId, this.deps.sessions);
    let prepared: PreparedTurn | undefined;
    let tools: TurnToolsAssembly | undefined;
    let terminal: 'completed' | 'failed' | 'aborted' = 'failed';

    try {
      emit({
        type: 'turn_started',
        sessionId,
        turnId,
        executionProfile: turn.executionProfile,
        narrativePolicy: turn.narrativePolicy,
      });

      // 预算的额度来自 agent 包 settings（settings 直读 µs 级；prepareTurn 内部也会冻结同一份）。
      const agentSettings = readAgentSettings(this.deps.settings);
      const budget = new TurnBudget({
        maxDurationMs: DEFAULT_MAX_DURATION_MS,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        maxToolCalls: agentSettings.maxToolCalls,
        maxSubagents: agentSettings.maxSubagents,
        maxConcurrentSubagents: agentSettings.maxConcurrentSubagents,
      });
      // compact 闭包按 Turn 创建一次（内部含失败熔断计数）；prepared 就绪前延迟求值。
      let compactForTurn: ((request: CompactRequest) => Promise<CompactResult>) | undefined;
      const parentMessages: Message[] = [];
      const prepareSubagent = createPrepareSubagent({
        sessionId,
        turnId,
        prepared: () => {
          if (!prepared) throw new Error('prepared 尚未就绪');
          return prepared;
        },
        providers: this.deps.providers,
        providerModels: this.deps.providerModels,
        createCompact: this.deps.createCompact,
        emit,
        budget,
        parentMessages,
      });

      prepared = await prepareTurn(this.deps, {
        request: input,
        turnId,
        budget,
        prepareSubagent,
        parentMessages,
        emit,
        onSubagentLlmCallFinished: event => {
          recordAgentLlmCallUsage(
            this.deps.usageRecorder,
            sessionId,
            turnId,
            event,
          );
        },
        signal,
      });
      tools = prepared.tools;
      this.runningTools.set(turnId, tools);
      this.deps.turns.setModel(turnId, prepared.providerId, prepared.modelId, prepared.protocol);
      this.deps.turns.setCharacterDirectoryName(turnId, this.deps.characterDirectoryName());
      compactForTurn = this.deps.createCompact(prepared.callLlm);

      for (const degradation of prepared.degradations) {
        emit({ type: 'request_degraded', sessionId, turnId, ...degradation });
      }

      const userText = explicitUserText(prepared.userMessageBlocks);

      // Reminder 先于用户消息落库：同一 Turn 的历史重放顺序即模型看到的顺序。
      // reminder 表示"本 Turn 开始时的事实"，整 Turn 只有这一条，不随 LLM Call 重建。
      const reminderInput = await this.deps.readTurnReminder({
        sessionId,
        turnId,
        executionProfile: turn.executionProfile,
        narrativePolicy: turn.narrativePolicy,
        userText,
        emit,
      });
      const reminderMessage = this.deps.sessions.appendMessage({
        turnId,
        sessionId,
        role: 'user',
        kind: 'reminder',
        blocks: renderTurnReminder(reminderInput),
      });
      // reminder 已持久化成功：宿主在此提交"已提醒"（Task reminder 两阶段提交点）。
      // 放在 appendMessage 之后，保证 Turn 准备失败不会吞掉低频提醒周期。
      if (reminderInput.taskReminder?.trim()) {
        this.deps.onTaskReminderPersisted?.(sessionId);
      }

      this.deps.sessions.appendMessage({
        turnId,
        sessionId,
        role: 'user',
        blocks: prepared.userMessageBlocks,
      });
      // 标题生成：用户消息落库即异步启动，不等 AgentLoop；只有用户消息触发的 Turn 参与。
      if (input.triggerType === 'userMessage' && userText.trim().length > 0) {
        this.deps.startSessionTitleGeneration?.(sessionId, userText);
      }

      // 历史区间 = reminder 之前的旧消息；reminder 从持久化读回（与落库同一份字节），
      // 用户输入以解析后的全量 parts 进入当前 Turn（附件真实内容只在这一形态）。
      // 两者都在不可压缩区间：Compact 只能改写 reminder 之前的旧历史。
      const persisted = this.deps.sessions.loadHistory(sessionId);
      const reminderIndex = persisted.findIndex(message => message.id === reminderMessage.id);
      if (reminderIndex < 0) {
        throw new Error('reminder 消息落库后未能从 Session History 读回');
      }
      // 每条 Assistant 历史关联所属 Turn 冻结的调用目标（providerId/modelId/protocol）；
      // 解析实现与 /compact Command 共用（createGenerationTargetResolver）。
      const resolveGenerationTarget = createGenerationTargetResolver(this.deps.turns);
      const attachmentIds = collectAttachmentReferenceIds(persisted);
      const attachmentsById = this.deps.attachments.getMany(attachmentIds);
      const supportsImageInput = prepared.supportsImageInput;
      const describeImage = this.deps.describeImage;
      const resolveAttachment = async (reference: AttachmentReferenceBlock) => {
        const [resolved] = await resolveAttachmentReferences(
          [reference],
          attachmentsById,
          {
            supportsImageInput,
            ...(describeImage ? { describeImage } : {}),
            signal,
          },
        );
        return resolved!;
      };
      const historyWithIds = await deriveLlmHistory(
        persisted.slice(0, reminderIndex),
        resolveGenerationTarget,
        resolveAttachment,
      );
      const currentTurnWithIds = await deriveLlmHistory(
        persisted.slice(reminderIndex),
        resolveGenerationTarget,
        resolveAttachment,
      );
      const initialMessages: Message[] = [
        ...historyWithIds.map(entry => entry.message),
        ...currentTurnWithIds.map(entry => entry.message),
      ];

      const contextEstimates = new Map<string, ContextUsageEstimate>();
      let currentContextUsage:
        | { readonly llmCallId: string; readonly usage: ContextUsage }
        | undefined;
      const publishEstimatedContext = (
        llmCallId: string,
        estimate: ContextUsageEstimate,
      ): void => {
        contextEstimates.set(llmCallId, estimate);
        const usage = estimatedContextUsage(estimate);
        currentContextUsage = { llmCallId, usage };
        emit({
          type: 'context_usage_updated',
          sessionId,
          turnId,
          llmCallId,
          usage,
        });
      };

      const prepareIteration = createPrepareLlmCall({
        sessionId,
        turnId,
        prepared,
        compact: compactForTurn,
        emit,
        budget,
        usageRecorder: this.deps.usageRecorder,
        baselineMessageCount: historyWithIds.length,
        // 根 Turn 的 Macro 摘要落 Session：身份数组供 summarizedMessageCount 映射覆盖游标。
        macroPersistence: {
          sessions: this.deps.sessions,
          baselineMessageIds: historyWithIds.map(entry => entry.sessionMessageId),
        },
        signal,
        onContextPrepared: publishEstimatedContext,
        onWorkingMessagesPrepared: messages => {
          parentMessages.splice(0, parentMessages.length, ...messages);
        },
      });

      let stopped: Extract<AgentLoopEvent, { type: 'loop_stopped' }> | undefined;
      const toolNames = new Map<string, string>();
      const stage = this.deps.stage;
      // 新 Turn 重置舞台扫描器；情绪状态跨 Turn 保留。
      stage?.beginTurn(sessionId);
      let lastTextBlockIndex: number | undefined;
      for await (const event of runAgentLoop({
        messages: initialMessages,
        prepareIteration,
        callLlm: prepared.callLlm,
        createToolExecutor: tools.createExecutor,
        budget,
        signal,
        maxIterations: prepared.maxIterations,
        // 当前 Turn 全部真实调用的生成目标；agentLoop 构造 assistant 时挂载。
        generationSource: {
          providerId: prepared.providerId,
          modelId: prepared.modelId,
          protocol: prepared.protocol,
        },
      })) {
        let downstream = event;
        if (stage && event.type === 'text_delta') {
          lastTextBlockIndex = event.blockIndex;
          const { cleaned, events: stageEvents } = stage.processChunk(event.delta, turnId, sessionId);
          for (const stageEvent of stageEvents) emit(stageEvent);
          // 整段都是表现标签：不落库不发 delta（用户可见正文没有这一段）。
          if (cleaned.length === 0) continue;
          downstream = { ...event, delta: cleaned };
        }
        await writer.apply(downstream);
        this.translate(downstream, sessionId, turnId, toolNames, emit);
        if (downstream.type === 'llm_call_usage_updated') {
          const estimate = contextEstimates.get(downstream.llmCallId);
          if (estimate) {
            const usage = providerContextUsage(estimate, downstream.usage);
            currentContextUsage = { llmCallId: downstream.llmCallId, usage };
            emit({
              type: 'context_usage_updated',
              sessionId,
              turnId,
              llmCallId: downstream.llmCallId,
              usage,
            });
          }
        }
        if (downstream.type === 'llm_call_finished') {
          recordAgentLlmCallUsage(
            this.deps.usageRecorder,
            sessionId,
            turnId,
            downstream,
          );
        }
        if (downstream.type === 'model_history_appended') {
          const current = currentContextUsage;
          if (current?.llmCallId === downstream.llmCallId) {
            const usage = appendEstimatedContextMessages(
              current.usage,
              downstream.messages,
            );
            currentContextUsage = { llmCallId: downstream.llmCallId, usage };
            emit({
              type: 'context_usage_updated',
              sessionId,
              turnId,
              llmCallId: downstream.llmCallId,
              usage,
            });
          }
        }
        if (downstream.type === 'loop_stopped') stopped = downstream;
      }

      // 扫描器未闭合尾部按正文释放：与 cleaned 同待遇（落库 + 发射），不吞模型输出。
      if (stage) {
        const { cleaned } = stage.flush(turnId, sessionId);
        if (cleaned.length > 0) {
          const flushed: AgentLoopEvent = {
            type: 'text_delta',
            blockIndex: lastTextBlockIndex ?? 0,
            delta: cleaned,
          };
          await writer.apply(flushed);
          this.translate(flushed, sessionId, turnId, toolNames, emit);
        }
      }

      if (!stopped) throw new Error('AgentLoop 未产生终止事件');

      const startedAt = turn.createdAt;
      if (stopped.state.stopReason === 'aborted') {
        terminal = 'aborted';
        this.deps.turns.abortTurn(sessionId, turnId);
        const outcome: TurnOutcome = { status: 'aborted', sessionId, turnId, reason: 'user_stop' };
        emit({ type: 'turn_aborted', sessionId, turnId, reason: outcome.reason });
        await this.finishSafely(channel, writer, terminal, tools, turnId, () => resolveCompletion(outcome));
        return;
      }

      if (stopped.state.stopReason === 'completed') {
        terminal = 'completed';
        const stats = {
          iterations: stopped.state.iterations,
          usageInputTokens: stopped.state.usage.inputTokens,
          usageOutputTokens: stopped.state.usage.outputTokens,
        };
        this.deps.turns.completeTurn(turnId, stats, () => {
          this.deps.onTurnCompletedInTransaction?.(turnId);
        });
        const outcome: TurnOutcome = {
          status: 'completed',
          sessionId,
          turnId,
          stats: {
            inputTokens: stats.usageInputTokens,
            outputTokens: stats.usageOutputTokens,
            durationMs: Date.now() - startedAt,
          },
        };
        emit({ type: 'turn_completed', sessionId, turnId, stats: outcome.stats });
        await this.finishSafely(channel, writer, terminal, tools, turnId, () => resolveCompletion(outcome));
        return;
      }

      terminal = 'failed';
      const code: TurnFailureCode = stopped.state.stopReason === 'max_iterations'
        ? 'turn/budget_exceeded'
        : 'turn/execution_failed';
      const outcome = this.failTurn(turn, code, `AgentLoop 终止：${stopped.state.stopReason}`, emit);
      await this.finishSafely(channel, writer, terminal, tools, turnId, () => resolveCompletion(outcome));
    } catch (error) {
      if (signal.aborted || error instanceof TurnEventChannelClosedError) {
        terminal = 'aborted';
        this.deps.turns.abortTurn(sessionId, turnId);
        const outcome: TurnOutcome = { status: 'aborted', sessionId, turnId, reason: 'user_stop' };
        emit({ type: 'turn_aborted', sessionId, turnId, reason: outcome.reason });
        await this.finishSafely(channel, writer, terminal, tools, turnId, () => resolveCompletion(outcome));
        return;
      }

      terminal = 'failed';
      try {
        const outcome = this.failTurn(turn, failureCodeOf(error), failureMessageOf(error), emit);
        await this.finishSafely(channel, writer, terminal, tools, turnId, () => resolveCompletion(outcome));
      } catch (terminalError) {
        await this.finishSafely(channel, writer, terminal, tools, turnId, () => undefined);
        rejectCompletion(terminalError);
      }
    } finally {
      this.runningTools.delete(turnId);
      this.runningCompletions.delete(turnId);
      this.deps.turns.clearRunning(sessionId, turnId);
      if (prepared?.scratchpadDir) {
        try {
          fs.rmSync(prepared.scratchpadDir, { recursive: true, force: true });
        } catch {
          // 临时目录清理失败不能覆盖已经确定的 Turn 终态。
        }
      }
    }
  }

  /** 终态提交后的统一收尾：writer 收口、交互清理、工具与子 Agent 停止、通道关闭。 */
  private async finishSafely(
    channel: TurnEventChannel<TurnStreamEvent>,
    writer: TurnMessageWriter,
    terminal: 'completed' | 'failed' | 'aborted',
    tools: TurnToolsAssembly | undefined,
    turnId: string,
    resolve: () => void,
  ): Promise<void> {
    try {
      await writer.finish(terminal);
    } catch {
      // 收口持久化失败已由 turn 终态承载，不再二次失败。
    }
    try {
      this.deps.interactionQueue.cancelForTurn(turnId, `turn ${terminal}`);
    } catch {
      // 队列清理失败不能覆盖终态。
    }
    if (tools) {
      try {
        await tools.shutdown(terminal);
      } catch {
        // 工具关闭失败不能覆盖终态。
      }
    }
    resolve();
    channel.finish();
  }

  private failTurn(
    turn: Turn,
    code: TurnFailureCode,
    message: string,
    emit: (event: TurnStreamEvent) => void,
  ): TurnOutcome {
    this.deps.turns.failTurn(turn.id, { errorCode: code, errorMessage: message });
    emit({ type: 'turn_failed', sessionId: turn.sessionId, turnId: turn.id, code, message });
    return {
      status: 'failed',
      sessionId: turn.sessionId,
      turnId: turn.id,
      code,
      message,
    };
  }

  private translate(
    event: AgentLoopEvent,
    sessionId: string,
    turnId: string,
    toolNames: Map<string, string>,
    emit: (event: TurnStreamEvent) => void,
  ): void {
    switch (event.type) {
      case 'iteration_started':
        emit({ type: 'agent_iteration', sessionId, turnId, n: event.iteration });
        return;
      case 'text_delta':
        emit({ type: 'output_text_delta', sessionId, turnId, blockIndex: event.blockIndex, delta: event.delta });
        return;
      case 'thinking_delta':
        emit({ type: 'reasoning_delta', sessionId, turnId, blockIndex: event.blockIndex, delta: event.delta });
        return;
      case 'thinking_completed':
        emit({ type: 'reasoning_complete', sessionId, turnId, blockIndex: event.blockIndex });
        return;
      case 'tool_use_partial':
        emit({ type: 'tool_call_partial', sessionId, blockIndex: event.blockIndex, callId: event.toolCallId, name: event.toolName, argsDelta: event.argsDelta });
        return;
      case 'tool_use_completed':
        toolNames.set(event.toolCallId, event.toolName);
        emit({ type: 'tool_call_complete', sessionId, blockIndex: event.blockIndex, callId: event.toolCallId, name: event.toolName, args: event.args });
        return;
      case 'agent_usage_updated':
        emit({ type: 'agent_usage_updated', sessionId, turnId, usage: event.usage });
        return;
      case 'tool_result': {
        const { result } = event;
        emit({
          type: 'tool_result',
          sessionId,
          callId: result.toolCallId,
          name: toolNames.get(result.toolCallId) ?? 'unknown',
          ...(result.isError
            ? { error: { code: result.errorCode ?? 'tool/error', message: String(result.content) } }
            : { output: result.content }),
          durationMs: result.durationMs ?? 0,
        });
        return;
      }
      case 'llm_call_usage_updated':
      case 'llm_call_finished':
      case 'assistant_message_completed':
      case 'model_history_appended':
        return;
      default:
        return;
    }
  }
}

/** Narrative 与标题只读取用户显式文本，不混入附件描述或 Skill 指引。 */
function explicitUserText(blocks: MessageBlocks): string {
  if (typeof blocks === 'string') return blocks;
  return blocks
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('');
}

/**
 * Assistant 历史按所属 Turn 冻结的调用目标（providerId/modelId/protocol）挂生成来源：
 * 查不到目标（Turn 缺失或 protocol 不在词表）返回 undefined，不伪造，由目标协议
 * Adapter 依据 generatedBy 裁决 thinking 重放。同一 Turn 的多条 Assistant 共享同一行
 * 冻结目标，按 turnId 缓存避免逐条重复 SQL。根 Turn 泵与 /compact Command 共用。
 */
export function createGenerationTargetResolver(
  turns: Pick<TurnStore, 'getTurn'>,
): (turnId: string) => LlmGenerationSource | undefined {
  const cache = new Map<string, LlmGenerationSource | undefined>();
  return (turnId) => {
    if (cache.has(turnId)) return cache.get(turnId);
    const turn = turns.getTurn(turnId);
    const source = turn?.providerId && turn.modelId && turn.protocol && isLlmProtocol(turn.protocol)
      ? { providerId: turn.providerId, modelId: turn.modelId, protocol: turn.protocol }
      : undefined;
    cache.set(turnId, source);
    return source;
  };
}

/** 根与子 Agent 共用的一次物理 LLM 调用终态记账。 */
function recordAgentLlmCallUsage(
  recorder: UsageRecorder | undefined,
  sessionId: string,
  turnId: string,
  event: Extract<AgentLoopEvent, { type: 'llm_call_finished' }>,
): void {
  recordLlmCallUsage(recorder, {
    providerId: event.source.providerId,
    modelId: event.source.modelId,
    status: event.status,
    startedAt: event.startedAt,
    durationMs: event.durationMs,
    ...(event.usage ? { usage: event.usage } : {}),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    usageContext: { callId: event.llmCallId, sessionId, turnId },
  });
}

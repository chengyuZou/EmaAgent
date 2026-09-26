// 根 Turn 的唯一公开执行入口：创建、驱动、唯一终态与取消。
import * as fs from 'node:fs';
import {
  runAgentLoop,
  type AgentLoopEvent,
  type PrepareAgentIteration,
} from '@ema-agent/agent';
import type { VisionDescriptionCache } from '@ema-agent/attachments';
import {
  appendEstimatedContextMessages,
  projectSessionMessages,
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
import type { NarrativeSearch } from '@ema-agent/narrative';
import { isLlmProtocol } from '@ema-agent/providers';
import {
  type MessageBlocks,
  type SessionMessage,
  type SessionStore,
} from '@ema-agent/session';
import type { StageEngine } from '@ema-agent/stage';
import type { Turn } from './types.js';
import { recordLlmCallUsage, type UsageRecorder } from '@ema-agent/usage';
import { TurnEventChannel } from './eventChannel.js';
import {
  failureCodeOf,
  failureMessageOf,
  TurnEventChannelClosedError,
  type TurnFailureCode,
} from './errors.js';
import type { TurnStreamEvent } from './events.js';
import { createPrepareAgentIteration } from './prepare/prepareAgentIteration.js';
import { createPrepareSubagent } from './prepare/prepareSubagent.js';
import { TurnMessageWriter } from './turnMessageWriter.js';
import {
  prepareTurn,
  prepareTurnInputParts,
  type PreparedTurn,
  type PrepareTurnDeps,
} from './prepare/prepareTurn.js';
import {
  renderTurnReminder,
  RenderTurnReminderInput,
} from './prepare/turnReminder.js';
import type { TurnToolsAssembly } from './prepare/prepareTurnTools.js';
import type { TurnStore } from './turnStore.js';
import type {
  ClaimedSessionContinuation,
  SessionContinuationQueue,
} from './sessionContinuationQueue.js';
import type {
  StartTurn,
  TurnHandle,
  TurnOutcome,
} from './types.js';

/**
 * Reminder 事实的作用域：git/任务/scratchpad 等工作区与 Session 事实、Narrative 召回
 * 所需的用户输入、以及召回事件的 Turn 事件流出口，全部按 Turn 绑定。
 */
export interface TurnReminderScope {
  readonly sessionId: string;
  readonly turnId: string;
  /** 与 Turn 行同一次冻结的角色目录名。 */
  readonly characterName: string;
  readonly sessionMode: Turn['sessionMode'];
  /** auto = NarrativeSearchTool 可见；always = Turn 开头查询一次并写入 reminder；off = 两者皆无。 */
  readonly narrativePolicy: Turn['narrativePolicy'];
  /** 本 Turn 冻结的召回闭包（prepareTurnTools 构建）；always 路径据此查询，off 或无能力为 undefined。 */
  readonly narrativeSearch?: NarrativeSearch;
  /** 本 Turn 用户文本. 纯后台续接触发时可以为空串. */
  readonly userText: string;
  /** Turn 级取消信号；reminder 期的召回随 Turn 中止一并取消。 */
  readonly signal: AbortSignal;
  readonly emit: (event: TurnStreamEvent) => void;
}

export interface TurnExecutorDeps extends PrepareTurnDeps {
  readonly turns: TurnStore;
  readonly sessions: Pick<
    SessionStore,
    | 'getSession'
    | 'listProjectFolders'
    | 'appendMessage'
    | 'appendHistorySummary'
    | 'loadHistory'
    | 'markMessageInterrupted'
    | 'updateMessageBlocks'
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
   * 发射形态），emotion_changed/motion_changed 随流发出。缺省时 delta 原样透传。
   */
  readonly stage?: StageEngine;
  /**
   * Prepare 完成时读取当前激活角色的 Character.name, 回填冻结到 Turn 行.
   * 与 characterPrompt 同一时点读取, 不使用可修改的 displayName.
   */
  readonly characterName: () => string;
  /**
   * completed 终态的同事务登记口（Memory 提取入队）。在 completeTurn 的 SQL 事务内
   * 同步调用：只许入队类写入，禁止在此启动异步工作。Memory 零 import——由装配层注入。
   */
  readonly onTurnCompletedInTransaction?: (turnId: string) => void;
  /** 用户排队输入和后台终态的唯一 Session 级续接所有者. */
  readonly continuations: SessionContinuationQueue;
}

/**
 * TurnExecutor 持有跨 Turn 共享的协作者；每个 Turn 的通道、预算、工具层与
 * 事件翻译都在 start() 内按 Turn 创建。Route 只拿这个入口，不接触任何内部件。
 */
export class TurnExecutor {
  /** 活动 Turn 的工具层快照，供 abortTool/abortSubagent 按 turnId 定位。 */
  private readonly runningTools = new Map<string, TurnToolsAssembly>();
  /** 活动 Turn 的 completion，供 abortAndAwait（Session 删除等编排）等待终态落库。 */
  private readonly runningCompletions = new Map<string, Promise<TurnOutcome>>();

  constructor(private readonly deps: TurnExecutorDeps) {}

  start(input: StartTurn): TurnHandle {
    const { turn, signal } = this.deps.turns.startTurn({
      turnId: input.turnId,
      sessionId: input.sessionId,
      triggerType: input.triggerType,
      sessionMode: input.sessionMode,
      narrativePolicy: input.narrativePolicy,
      ttsEnabled: input.ttsEnabled,
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
    const running = this.deps.turns.getRunningTurn(sessionId);
    if (running?.id !== turnId) return false;
    this.deps.turns.requestAbort(sessionId, turnId);
    return true;
  }

  /**
   * 取消并等待该 Turn 终态落库。Session 删除等编排必须先让活动 Turn 走完
   * finish 链（writer 收口、队列清理），否则删除会与尚未完成的持久化竞争。
   */
  async abortAndAwait(sessionId: string, turnId: string): Promise<void> {
    this.abort(sessionId, turnId);
    await this.runningCompletions.get(turnId)?.catch(() => undefined);
  }

  abortTool(turnId: string, toolCallId: string): boolean {
    return this.runningTools.get(turnId)?.abortTool(toolCallId) ?? false;
  }

  abortSubagent(turnId: string, subagentId: string): boolean {
    return this.runningTools.get(turnId)?.abortSubagent(subagentId) ?? false;
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
      try {
        channel.push(event);
      } catch (error) {
        if (!(error instanceof TurnEventChannelClosedError)) throw error;
      }
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
        triggerType: turn.triggerType,
        sessionMode: turn.sessionMode,
        narrativePolicy: turn.narrativePolicy,
        ttsEnabled: turn.ttsEnabled,
      });

      let compact: ((request: CompactRequest) => Promise<CompactResult>) | undefined;
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
        parentMessages,
      });

      prepared = await prepareTurn(this.deps, {
        request: input,
        turnId,
        prepareSubagent,
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
      const characterName = this.deps.characterName();
      this.deps.turns.setCharacterName(turnId, characterName);
      compact = this.deps.createCompact(prepared.callLlm);

      for (const degradation of prepared.degradations) {
        emit({ type: 'request_degraded', sessionId, turnId, ...degradation });
      }

      const userText = explicitUserText(prepared.userMessageBlocks);

      // Reminder 先于用户消息落库：同一 Turn 的历史重放顺序即模型看到的顺序。
      // reminder 表示"本 Turn 开始时的事实"，整 Turn 只有这一条，不随 LLM Call 重建。
      const reminderInput = await this.deps.readTurnReminder({
        sessionId,
        turnId,
        characterName,
        sessionMode: turn.sessionMode,
        narrativePolicy: turn.narrativePolicy,
        ...(tools.narrativeSearch ? { narrativeSearch: tools.narrativeSearch } : {}),
        userText,
        signal,
        emit,
      });
      this.deps.sessions.appendMessage({
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

      // 后台终态使用内部 Message kind, 避免 History 把它伪装成用户手写内容.
      // 此处只写 id 与终态, 完整结果仍由模型通过对应查询工具读取.
      if (input.completionNoticeText) {
        this.deps.sessions.appendMessage({
          turnId,
          sessionId,
          role: 'user',
          kind: 'continuation',
          blocks: input.completionNoticeText,
        });
      }
      if (prepared.userMessageBlocks.length > 0) {
        const userMessage = this.deps.sessions.appendMessage({
          turnId,
          sessionId,
          role: 'user',
          blocks: prepared.userMessageBlocks,
        });
        emit({ type: 'user_message_stored', message: userMessage });
      }
      // 队列项和后台结果只有在对应 Message 全部落库后才确认交付.
      this.deps.continuations.acknowledge(turnId);

      const turnSkillPool = prepared.skillPool;
      const persistClaim = async (
        claim: ClaimedSessionContinuation,
      ): Promise<SessionMessage> => {
        if (claim.type === 'completion_notices') {
          // completionNoticeText 不会在前端显示 因此无需 emit 事件
          return this.deps.sessions.appendMessage({
            turnId,
            sessionId,
            role: 'user',
            kind: 'continuation',
            blocks: claim.completionNoticeText,
          });
        }

        const blocks = await prepareTurnInputParts(
          this.deps.attachments,
          sessionId,
          turnId,
          claim.userInput.input,
          turnSkillPool,
        );

        const userMessage = this.deps.sessions.appendMessage({
          turnId,
          sessionId,
          role: 'user',
          blocks,
        });
        emit({ type: 'user_message_stored', message: userMessage });
        return userMessage;
      };

      const persistNextIterationMessages = async (): Promise<SessionMessage[]> => {
        const appended: SessionMessage[] = [];
        while (true) {
          const claim = this.deps.continuations.claimNextIteration(sessionId, turnId);
          if (!claim) return appended;
          try {
            appended.push(await persistClaim(claim));
            // 一个 claim 只生成一条 Message；确认后才能领取下一个 claim.
            this.deps.continuations.acknowledge(turnId);
          } catch (error) {
            this.deps.continuations.release(turnId);
            throw error;
          }
        }
      };
      // 历史, reminder 与本 Turn 用户输入按 SQL 顺序投影为同一条模型消息链.
      // 后续 Macro 可以覆盖完整有效前缀, 不再被 Turn 边界截断.
      const persisted = this.deps.sessions.loadHistory(sessionId);
      // 每条 Assistant 历史关联所属 Turn 冻结的调用目标（providerId/modelId/protocol）；
      // 解析实现与 /compact Command 共用（createGenerationTargetResolver）。
      const resolveGenerationTarget = createGenerationTargetResolver(this.deps.turns);
      // 附件投影:图片字节在入库时已规范化,这里只按能力分流(直发/描述/标记)。
      const attachmentOptions = {
        supportsImageInput: prepared.supportsImageInput,
        ...(this.deps.visionCache ? { visionCache: this.deps.visionCache } : {}),
        ...(this.deps.describeImage ? { describeImage: this.deps.describeImage } : {}),
        signal,
      };
      const projected = await projectSessionMessages(
        persisted,
        resolveGenerationTarget,
        attachmentOptions,
      );
      const initialMessages: Message[] = projected.map(entry => entry.message);
      // 未落库的模型专用引导也占消息位置, 但没有 SQL ID.
      const messageIds: (string | undefined)[] = projected.map(entry => entry.sessionMessageId);
      const pendingMessageIds: (string | undefined)[] = [];

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

      const prepareAgentIteration = createPrepareAgentIteration({
        sessionId,
        turnId,
        prepared,
        compact: compact,
        emit,
        usageRecorder: this.deps.usageRecorder,
        // 与 AgentLoop 消息按位置对齐; Macro 保存时用被覆盖前缀的 SQL 身份.
        macroPersistence: {
          sessions: this.deps.sessions,
          messageIds,
        },
        signal,
        onContextPrepared: publishEstimatedContext,
      });
      const prepareIteration: PrepareAgentIteration = async input => {
        const iteration = await prepareAgentIteration(input);
        // fork 读取当前父模型消息; System 和本次请求缓存标记均不在此数组中.
        parentMessages.splice(0, parentMessages.length, ...iteration.messages);
        return iteration;
      };

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
        takeNextIterationMessages: async () => {
          const appended = await persistNextIterationMessages();
          const projected = await projectSessionMessages(
            appended,
            resolveGenerationTarget,
            attachmentOptions,
          );
          pendingMessageIds.push(...projected.map(entry => entry.sessionMessageId));
          return projected.map(entry => entry.message);
        },
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
        const storedMessageId = await writer.apply(downstream);
        if (downstream.type === 'assistant_message_completed' || downstream.type === 'tool_result') {
          pendingMessageIds.push(storedMessageId);
        }
        if (downstream.type === 'model_history_appended') {
          // 完整 Assistant, 独立 ToolResult, 追加输入依次消耗已落库 ID.
          // 续写提示与 stuck guide 只在模型历史里出现, 留下 undefined 位置.
          for (let index = 0; index < downstream.messages.length; index += 1) {
            messageIds.push(pendingMessageIds.shift());
          }
        }
        this.translate(downstream, sessionId, turnId, writer, toolNames, emit);
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

      // 扫描器未闭合尾部按正文释放
      if (stage) {
        const { cleaned } = stage.flush(sessionId);
        if (cleaned.length > 0) {
          const flushed: AgentLoopEvent = {
            type: 'text_delta',
            blockIndex: lastTextBlockIndex ?? 0,
            delta: cleaned,
          };
          await writer.apply(flushed);
          this.translate(flushed, sessionId, turnId, writer, toolNames, emit);
        }
      }

      if (!stopped) throw new Error('AgentLoop 未产生终止事件');

      if (stopped.state.stopReason === 'aborted') {
        terminal = 'aborted';
        this.deps.turns.abortTurn(sessionId, turnId);
        const outcome: TurnOutcome = { status: 'aborted', sessionId, turnId, reason: 'user_stop' };
        await this.finishSafely(
          channel, writer, terminal, tools, turnId,
          () => resolveCompletion(outcome),
          rejectCompletion,
          () => emit({ type: 'turn_aborted', sessionId, turnId, reason: outcome.reason }),
        );
        return;
      }

      if (stopped.state.stopReason === 'completed') {
        terminal = 'completed';
        this.deps.turns.completeTurn(turnId, () => {
          this.deps.onTurnCompletedInTransaction?.(turnId);
        });
        const outcome: TurnOutcome = {
          status: 'completed',
          sessionId,
          turnId,
        };
        await this.finishSafely(
          channel, writer, terminal, tools, turnId,
          () => resolveCompletion(outcome),
          rejectCompletion,
          () => emit({ type: 'turn_completed', sessionId, turnId }),
        );
        return;
      }

      terminal = 'failed';
      const code: TurnFailureCode = stopped.state.stopReason === 'max_iterations'
        ? 'turn/budget_exceeded'
        : 'turn/execution_failed';
      const outcome = this.failTurn(turn, code, `AgentLoop 终止：${stopped.state.stopReason}`);
      await this.finishSafely(
        channel, writer, terminal, tools, turnId,
        () => resolveCompletion(outcome),
        rejectCompletion,
        () => emit({ type: 'turn_failed', sessionId, turnId, code, message: outcome.message }),
      );
    } catch (error) {
      // 准备或持久化失败时, 尚未确认的队列项必须回到可领取状态.
      this.deps.continuations.release(turnId);
      if (signal.aborted || error instanceof TurnEventChannelClosedError) {
        terminal = 'aborted';
        this.deps.turns.abortTurn(sessionId, turnId);
        const outcome: TurnOutcome = { status: 'aborted', sessionId, turnId, reason: 'user_stop' };
        await this.finishSafely(
          channel, writer, terminal, tools, turnId,
          () => resolveCompletion(outcome),
          rejectCompletion,
          () => emit({ type: 'turn_aborted', sessionId, turnId, reason: outcome.reason }),
        );
        return;
      }

      terminal = 'failed';
      try {
        const outcome = this.failTurn(turn, failureCodeOf(error), failureMessageOf(error));
        await this.finishSafely(
          channel, writer, terminal, tools, turnId,
          () => resolveCompletion(outcome),
          rejectCompletion,
          () => emit({
            type: 'turn_failed',
            sessionId,
            turnId,
            code: outcome.code,
            message: outcome.message,
          }),
        );
      } catch (terminalError) {
        await this.finishSafely(channel, writer, terminal, tools, turnId, () => undefined, rejectCompletion);
        rejectCompletion(terminalError);
      }
    } finally {
      this.runningTools.delete(turnId);
      this.runningCompletions.delete(turnId);
      this.deps.turns.clearRunning(sessionId, turnId);
      // 下一根排队 Turn 只能在当前运行记录清除后启动. completion Promise 在此前已兑现,
      // 因而不能由它负责唤醒, 否则队列会把本 Session 误判为仍在执行.
      if (terminal === 'completed') this.deps.continuations.turnCompleted(sessionId);
      if (prepared?.scratchpadDir) {
        const scratchpadDir = prepared.scratchpadDir;
        // 后台 Subagent 继续使用父 Turn 的 scratchpad. 清理动作跟随最后一个
        // 派生运行结束, 但不反向占住已经完成的根 Turn.
        void this.deps.subagents.waitForTurnSubagents(turnId).then(() => {
          try {
            fs.rmSync(scratchpadDir, { recursive: true, force: true });
          } catch {
            // 临时目录清理失败不能覆盖已经确定的 Turn 终态.
          }
        });
      }
    }
  }

  /** 终态提交后的统一收尾：writer 与工具完成后才发终态事件并关闭通道。 */
  private async finishSafely(
    channel: TurnEventChannel<TurnStreamEvent>,
    writer: TurnMessageWriter,
    terminal: 'completed' | 'failed' | 'aborted',
    tools: TurnToolsAssembly | undefined,
    turnId: string,
    resolve: () => void,
    reject: (error: unknown) => void,
    emitTerminal?: () => void,
  ): Promise<void> {
    let writerFinished = false;
    let writerError: unknown;
    try {
      await writer.finish(terminal);
      writerFinished = true;
    } catch (error) {
      writerError = error;
      console.warn('[turn] 消息收口失败，终态事件未广播:', error);
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
    if (!writerFinished) {
      reject(writerError);
      channel.fail(writerError);
      return;
    }
    emitTerminal?.();
    resolve();
    channel.finish();
  }

  private failTurn(
    turn: Turn,
    code: TurnFailureCode,
    message: string,
  ): Extract<TurnOutcome, { status: 'failed' }> {
    this.deps.turns.failTurn(turn.id, { errorCode: code, errorMessage: message });
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
    writer: TurnMessageWriter,
    toolNames: Map<string, string>,
    emit: (event: TurnStreamEvent) => void,
  ): void {
    switch (event.type) {
      case 'iteration_started':
        this.deps.turns.setIterations(turnId, event.iteration);
        emit({
          type: 'agent_iteration',
          sessionId,
          turnId,
          n: event.iteration,
          assistantMessageId: writer.currentAssistantMessageId,
        });
        return;
      case 'text_delta':
        emit({
          type: 'output_text_delta',
          sessionId,
          turnId,
          blockIndex: event.blockIndex,
          delta: event.delta,
          assistantMessageId: writer.currentAssistantMessageId,
        });
        return;
      case 'thinking_delta':
        emit({
          type: 'reasoning_delta',
          sessionId,
          turnId,
          blockIndex: event.blockIndex,
          delta: event.delta,
          assistantMessageId: writer.currentAssistantMessageId,
        });
        return;
      case 'thinking_completed':
        emit({
          type: 'reasoning_complete',
          sessionId,
          turnId,
          blockIndex: event.blockIndex,
          assistantMessageId: writer.currentAssistantMessageId,
        });
        return;
      case 'tool_use_partial':
        emit({
          type: 'tool_call_partial',
          sessionId,
          turnId,
          blockIndex: event.blockIndex,
          callId: event.toolCallId,
          name: event.toolName,
          argsDelta: event.argsDelta,
          assistantMessageId: writer.currentAssistantMessageId,
        });
        return;
      case 'tool_use_completed':
        toolNames.set(event.toolCallId, event.toolName);
        emit({
          type: 'tool_call_complete',
          sessionId,
          turnId,
          blockIndex: event.blockIndex,
          callId: event.toolCallId,
          name: event.toolName,
          args: event.args,
          assistantMessageId: writer.currentAssistantMessageId,
        });
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
            : { output: result.data ?? result.content }),
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

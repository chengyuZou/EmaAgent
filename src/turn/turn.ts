import * as fs from 'node:fs';
import {
  runAgentLoop,
  type AgentLoopEvent,
  type PrepareAgentIteration,
} from '@ema-agent/agent';
import type { VisionDescriptionCache } from '@ema-agent/attachments';
import { projectMessages } from '@ema-agent/context';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import type {
  CompleteLLM,
  LLMGenerationSource,
  Message,
} from '@ema-agent/llm';
import { isLLMProtocol } from '@ema-agent/providers';
import {
  DEFAULT_SESSION_TITLE,
  type MessageBlocks,
  type SessionMessage,
  type SessionStore,
} from '@ema-agent/session';
import type { StageEngine } from '@ema-agent/stage';
import type { Turn } from './types.js';
import type { UsageRecorder } from '@ema-agent/usage';
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
import { createForkParentMessages } from './forkParentMessages.js';
import { createTurnLoopEvents } from './turnLoopEvents.js';
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
 * Reminder 读取当前 Turn 的工作区, 任务, Memory 等事实, 不在准备阶段执行工具查询.
 */
export interface TurnReminderScope {
  readonly sessionId: string;
  readonly turnId: string;
  /** 与 Turn 行同一次冻结的角色目录名. */
  readonly characterName: string;
  /** 本 Turn 用户文本. 内部续接触发时可以为空串. */
  readonly userText: string;
  /** Turn 级取消信号;reminder 期的召回随 Turn 中止一并取消. */
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
    | 'getMessage'
    | 'markMessageInterrupted'
    | 'updateMessageBlocks'
    | 'updateTitleIfDefault'
  >;
  readonly hasNormalUserMessage: (sessionId: string) => boolean;
  readonly createCompact: (
    completeLLM: CompleteLLM,
  ) => (request: CompactRequest) => Promise<CompactResult>;
  /**
   * 每个 Turn 调用一次,产出 reminder 的完整启动期输入(含 currentDate 等全部字段:
   * git 探测,Memory 摘要,Task 一次性提醒,Scratchpad 快照).
   * 结果即冻结,本 Turn 后续 LLM Call 复用同一份持久化 reminder,不再回读.
   */
  readonly readTurnReminder: (
    scope: TurnReminderScope,
  ) => Promise<RenderTurnReminderInput> | RenderTurnReminderInput;
  /**
   * Task 低频提醒在 reminder Message 成功持久化后提交"已提醒";只有提醒确实送达
   * 才推进提醒周期,Turn 准备失败不吞掉周期.没有第二种提交行为,不做通用回调.
   */
  readonly onTaskReminderPersisted?: (sessionId: string) => void;
  /** 逐次记录真实 LLM 调用; 未注入时不记录, 注入实现抛错会使当前执行失败. */
  readonly usageRecorder?: UsageRecorder;
  /**
   * 角色舞台:text delta 在落库与发射前经它剥离表现标签(cleaned 是唯一持久化与
   * 发射形态),emotion_changed/motion_changed 随流发出.缺省时 delta 原样透传.
   */
  readonly stage?: StageEngine;
  /**
   * Prepare 开始时与 characterPrompt 一起读取当前 Character.name.
   * Prepare 完成后写入 Turn 行, 不使用可修改的 displayName.
   */
  readonly characterName: () => string;
  /**
   * completed 终态的同事务登记口(Memory 提取入队).在 completeTurn 的 SQL 事务内
   * 同步调用:只许入队类写入,禁止在此启动异步工作.Memory 零 import--由装配层注入.
   */
  readonly onTurnCompletedInTransaction?: (turnId: string) => void;
  /** 用户排队输入, 后台终态和 Goal 的唯一 Session 级续接所有者. */
  readonly continuations: SessionContinuationQueue;
}

/**
 * TurnExecutor 持有跨 Turn 共享的协作者;每个 Turn 的通道,预算,工具层与
 * 事件翻译都在 start() 内按 Turn 创建. SessionContinuationQueue 调用 start 启动执行.
 */
export class TurnExecutor {
  /** 活动 Turn 的工具执行入口, 供 abortTool 按 turnId 定位. */
  private readonly runningTools = new Map<string, TurnToolsAssembly>();
  /** 活动 Turn 的 completion,供 abortAndAwait(Session 删除等编排)等待终态落库. */
  private readonly runningCompletions = new Map<string, Promise<TurnOutcome>>();

  constructor(private readonly deps: TurnExecutorDeps) {}

  start(input: StartTurn): TurnHandle {
    const { turn, signal } = this.deps.turns.startTurn({
      turnId: input.turnId,
      sessionId: input.sessionId,
      triggerType: input.triggerType,
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
    // Server 主要消费 events;预先观察 rejection,避免极端持久化故障形成未处理 Promise.
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

  /** 只取消当前仍活动的指定 Turn; 历史句柄不能误杀后继 Turn. */
  abort(sessionId: string, turnId: string): boolean {
    const running = this.deps.turns.getRunningTurn(sessionId);
    if (running?.id !== turnId) return false;
    this.deps.turns.requestAbort(sessionId, turnId);
    return true;
  }

  /**
   * 取消并等待该 Turn 终态落库.Session 删除等编排必须先让活动 Turn 走完
   * finish 链(保存未完成消息, 清理等待), 否则删除会与尚未完成的持久化竞争.
   */
  async abortAndAwait(sessionId: string, turnId: string): Promise<void> {
    this.abort(sessionId, turnId);
    await this.runningCompletions.get(turnId)?.catch(() => undefined);
  }

  abortTool(turnId: string, toolCallId: string): boolean {
    return this.runningTools.get(turnId)?.abortTool(toolCallId) ?? false;
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
    let handledGoalId: string | undefined;
    const forkParentMessages = createForkParentMessages(this.deps.sessions);
    const loopEvents = createTurnLoopEvents({
      sessionId,
      turnId,
      turns: this.deps.turns,
      writer,
      usageRecorder: this.deps.usageRecorder,
      emit,
    });

    try {
      const initialGoal = this.deps.goalStore?.getCurrent(sessionId);
      handledGoalId = initialGoal?.status === 'active' ? initialGoal.id : undefined;
      emit({
        type: 'turn_started',
        sessionId,
        turnId,
        triggerType: turn.triggerType,
        ttsEnabled: turn.ttsEnabled,
      });

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
        usageRecorder: this.deps.usageRecorder,
        visionCache: this.deps.visionCache,
        describeImage: this.deps.describeImage,
        emit,
        readParentMessages: forkParentMessages.read,
      });

      // 人设和名字在同一次同步读取中固定, 准备期间切换角色不混用两份角色信息.
      const characterName = this.deps.characterName();
      const characterPrompt = this.deps.characterPrompt();
      prepared = await prepareTurn({
        ...this.deps,
        characterPrompt: () => characterPrompt,
      }, {
        request: input,
        turnId,
        prepareSubagent,
        emit,
        onSubagentLLMCallFinished: loopEvents.recordLLMCall,
        signal,
      });
      tools = prepared.tools;
      this.runningTools.set(turnId, tools);
      signal.throwIfAborted();
      this.deps.turns.setModel(turnId, prepared.providerId, prepared.modelId, prepared.protocol);
      this.deps.turns.setCharacterName(turnId, characterName);

      for (const degradation of prepared.degradations) {
        emit({ type: 'request_degraded', sessionId, turnId, ...degradation });
      }

      const userText = explicitUserText(prepared.userMessageBlocks);

      // Reminder 先于用户消息落库:同一 Turn 的历史重放顺序即模型看到的顺序.
      // reminder 表示"本 Turn 开始时的事实",整 Turn 只有这一条,不随 LLM Call 重建.
      const reminderInput = await this.deps.readTurnReminder({
        sessionId,
        turnId,
        characterName,
        userText,
        signal,
        emit,
      });
      // 等待期间可能已归档或删除, 尚未交付的输入不能在停止后写入历史.
      signal.throwIfAborted();
      handledGoalId = reminderInput.goal?.status === 'active' ? reminderInput.goal.id : undefined;
      this.deps.sessions.appendMessage({
        turnId,
        sessionId,
        role: 'user',
        kind: 'reminder',
        blocks: renderTurnReminder(reminderInput),
      });
      // reminder 已持久化成功:宿主在此提交"已提醒"(Task reminder 两阶段提交点).
      // 放在 appendMessage 之后,保证 Turn 准备失败不会吞掉低频提醒周期.
      if (reminderInput.taskReminder?.trim()) {
        this.deps.onTaskReminderPersisted?.(sessionId);
      }

      // 内部完成通知与 Goal 续接共用 Message kind, 不伪装成用户手写内容.
      if (input.continuationText) {
        this.deps.sessions.appendMessage({
          turnId,
          sessionId,
          role: 'user',
          kind: 'continuation',
          blocks: input.continuationText,
        });
      }
      if (prepared.userMessageBlocks.length > 0) {
        const shouldRename = this.deps.sessions.getSession(sessionId).title === DEFAULT_SESSION_TITLE
          && !this.deps.hasNormalUserMessage(sessionId);
        // 判断后直接保存, 中间不 await, 避免另一条用户消息先写入.
        const userMessage = this.deps.sessions.appendMessage({
          sessionId,
          turnId,
          role: 'user',
          blocks: prepared.userMessageBlocks,
        });
        if (shouldRename) {
          try {
            this.deps.sessions.updateTitleIfDefault(
              sessionId,
              createSessionTitle(prepared.userMessageBlocks),
            );
          } catch (error) {
            // 消息已保存, 改名失败不能阻止消息交付或模型继续执行.
            console.warn('[turn] 自动命名会话失败:', error);
          }
        }
        const queuedInputIds = this.deps.continuations.acknowledge(turnId);
        emit({ type: 'user_message_stored', message: userMessage, queuedInputIds });
      } else {
        this.deps.continuations.acknowledge(turnId);
      }

      const turnSkillPool = prepared.skillPool;
      const persistClaim = async (
        claim: ClaimedSessionContinuation,
      ): Promise<SessionMessage> => {
        if (claim.type === 'continuation') {
          // 内部续接文本不在聊天显示, 只持久化并交给模型.
          return this.deps.sessions.appendMessage({
            turnId,
            sessionId,
            role: 'user',
            kind: 'continuation',
            blocks: claim.continuationText,
          });
        }

        const blocks = await prepareTurnInputParts(
          this.deps.attachments,
          sessionId,
          turnId,
          claim.input,
          turnSkillPool,
        );
        signal.throwIfAborted();

        const shouldRename = this.deps.sessions.getSession(sessionId).title === DEFAULT_SESSION_TITLE
          && !this.deps.hasNormalUserMessage(sessionId);
        const userMessage = this.deps.sessions.appendMessage({
          sessionId,
          turnId,
          role: 'user',
          blocks,
        });
        if (shouldRename) {
          try {
            this.deps.sessions.updateTitleIfDefault(sessionId, createSessionTitle(blocks));
          } catch (error) {
            console.warn('[turn] 自动命名会话失败:', error);
          }
        }
        return userMessage;
      };

      const persistNextIterationMessages = async (): Promise<SessionMessage[]> => {
        const appended: SessionMessage[] = [];
        while (true) {
          const claim = this.deps.continuations.claimNextIteration(sessionId, turnId);
          if (!claim) return appended;
          try {
            const message = await persistClaim(claim);
            appended.push(message);
            const queuedInputIds = this.deps.continuations.acknowledge(turnId);
            if (claim.type === 'user_input') {
              emit({ type: 'user_message_stored', message, queuedInputIds });
            }
          } catch (error) {
            this.deps.continuations.release(turnId);
            throw error;
          }
        }
      };
      // 历史, reminder 与本 Turn 用户输入按 SQL 顺序投影为同一条模型消息链.
      // 后续 Macro 可以覆盖完整有效前缀, 不再被 Turn 边界截断.
      const persisted = this.deps.sessions.loadHistory(sessionId);
      const historyResolver = createTurnHistoryResolver(this.deps.turns);
      const resolveCharacter = (message: SessionMessage): string | undefined => {
        if (!message.turnId) {
          return undefined;
        }
        const historicalCharacter = historyResolver.resolveCharacter(message.turnId);
        return historicalCharacter !== characterName ? historicalCharacter : undefined;
      };
      // 附件投影:图片字节在入库时已规范化,这里只按能力分流(直发/描述/标记).
      const attachmentOptions = {
        supportsImageInput: prepared.supportsImageInput,
        ...(this.deps.visionCache ? { visionCache: this.deps.visionCache } : {}),
        ...(this.deps.describeImage ? { describeImage: this.deps.describeImage } : {}),
        signal,
      };
      const projected = await projectMessages(
        persisted,
        message => message.turnId ? historyResolver.resolveGenerationSource(message.turnId) : undefined,
        attachmentOptions,
        resolveCharacter,
      );
      const initialMessages: Message[] = projected.map(entry => entry.message);
      // 未落库的模型专用引导也占消息位置, 但没有 SQL ID.
      const messageIds: (string | undefined)[] = projected.map(entry => entry.messageId);
      const pendingMessageIds: (string | undefined)[] = [];

      const prepareAgentIteration = createPrepareAgentIteration({
        sessionId,
        turnId,
        prepared,
        createCompact: this.deps.createCompact,
        usageRecorder: this.deps.usageRecorder,
        emit,
        // 与 AgentLoop 消息按位置对齐; Macro 保存时用被覆盖前缀的 SQL 身份.
        macroPersistence: {
          appendSummary: (summary, throughMessageId, savedTokens) => this.deps.sessions.appendHistorySummary({
            sessionId, turnId, summary, savedTokens, summarizedThroughMessageId: throughMessageId,
          }),
          messageIds,
        },
        signal,
        onContextPrepared: loopEvents.onContextPrepared,
      });
      const prepareIteration: PrepareAgentIteration = async input => {
        const iteration = await prepareAgentIteration(input);
        // 每次物理父请求独立交接, 包含 Compact 改写后的历史, 不订阅后续迭代.
        forkParentMessages.beginRequest(iteration.messages, messageIds);
        return iteration;
      };

      let stopped: Extract<AgentLoopEvent, { type: 'loop_stopped' }> | undefined;
      const stage = this.deps.stage;
      // 新 Turn 重置舞台扫描器;情绪状态跨 Turn 保留.
      stage?.beginTurn(sessionId);
      let lastTextBlockIndex: number | undefined;
      for await (const event of runAgentLoop({
        messages: initialMessages,
        prepareIteration,
        callLLM: prepared.callLLM,
        createToolExecutor: tools.createExecutor,
        takeNextIterationMessages: async () => {
          const appended = await persistNextIterationMessages();
          const projected = await projectMessages(
            appended,
            message => message.turnId ? historyResolver.resolveGenerationSource(message.turnId) : undefined,
            attachmentOptions,
            resolveCharacter,
          );
          pendingMessageIds.push(...projected.map(entry => entry.messageId));
          return projected.map(entry => entry.message);
        },
        signal,
        maxIterations: prepared.maxIterations,
        // 当前 Turn 全部真实调用的生成目标;agentLoop 构造 assistant 时挂载.
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
          // 整段都是表现标签:不落库不发 delta(用户可见正文没有这一段).
          if (cleaned.length === 0) continue;
          downstream = { ...event, delta: cleaned };
        }
        const storedMessageId = await writer.apply(downstream);
        if (downstream.type === 'assistant_message_completed') {
          // 父消息先落库, 再让 fork 发出第一条模型请求. 副本中的占位不进入 writer.
          // 空回复没有 Message 行, 也没有可以发起 fork 的工具调用.
          forkParentMessages.completeAssistant(storedMessageId, {
            providerId: prepared.providerId,
            modelId: prepared.modelId,
            protocol: prepared.protocol,
          });
        }
        if (downstream.type === 'llm_call_finished' && downstream.status !== 'completed') {
          // 在恢复 generator 的工具清理之前释放等待, 不能等外层 catch 才结束 fork 准备.
          forkParentMessages.fail(new Error(`父 Assistant 未完成, fork 准备终止: ${downstream.errorCode ?? downstream.status}`));
        }
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
        loopEvents.accept(downstream);
        if (downstream.type === 'loop_stopped') {
          stopped = downstream;
          forkParentMessages.fail(new Error(`父循环已结束: ${downstream.state.stopReason}`));
        }
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
          loopEvents.accept(flushed);
        }
      }

      if (!stopped) throw new Error('AgentLoop 未产生终止事件');

      if (stopped.state.stopReason === 'aborted') {
        terminal = 'aborted';
        this.deps.turns.abortTurn(sessionId, turnId);
        const outcome: TurnOutcome = { status: 'aborted', sessionId, turnId, reason: 'user_stop' };
        await this.finishSafely(
          channel, writer, terminal, tools, turn, signal, handledGoalId,
          () => resolveCompletion(outcome),
          rejectCompletion,
          () => emit({ type: 'turn_aborted', sessionId, turnId, reason: outcome.reason }),
        );
        return;
      }

      const currentGoal = this.deps.goalStore?.getCurrent(sessionId);
      // 单 Turn 配额只切分仍在推进的同一个 Goal. 子代理的 max_iterations
      // 不经过此 Turn 分支; 无 Goal 的执行仍以原失败策略结束.
      const goalIterationYield = stopped.state.stopReason === 'max_iterations'
        && currentGoal?.status === 'active'
        && currentGoal.id === handledGoalId;
      if (stopped.state.stopReason === 'completed' || goalIterationYield) {
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
          channel, writer, terminal, tools, turn, signal, handledGoalId,
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
      const outcome = this.failTurn(turn, code, `AgentLoop 终止:${stopped.state.stopReason}`);
      await this.finishSafely(
        channel, writer, terminal, tools, turn, signal, handledGoalId,
        () => resolveCompletion(outcome),
        rejectCompletion,
        () => emit({ type: 'turn_failed', sessionId, turnId, code, message: outcome.message }),
      );
    } catch (error) {
      forkParentMessages.fail(error);
      // 准备或持久化失败时, 尚未确认的队列项必须回到可领取状态.
      this.deps.continuations.release(turnId);
      if (signal.aborted || error instanceof TurnEventChannelClosedError) {
        terminal = 'aborted';
        this.deps.turns.abortTurn(sessionId, turnId);
        const outcome: TurnOutcome = { status: 'aborted', sessionId, turnId, reason: 'user_stop' };
        await this.finishSafely(
          channel, writer, terminal, tools, turn, signal, handledGoalId,
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
          channel, writer, terminal, tools, turn, signal, handledGoalId,
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
        await this.finishSafely(channel, writer, terminal, tools, turn, signal, handledGoalId, () => undefined, rejectCompletion);
        rejectCompletion(terminalError);
      }
    } finally {
      this.runningTools.delete(turnId);
      this.runningCompletions.delete(turnId);
      this.deps.turns.clearRunning(sessionId, turnId);
      if (prepared?.scratchpadDir) {
        const scratchpadDir = prepared.scratchpadDir;
        // 后台 Subagent 继续使用父 Turn 的 scratchpad. 清理动作跟随最后一个
        // 派生运行结束, 但不反向占住已经完成的 Turn.
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

  /** 终态提交后的统一收尾:writer 与工具完成后才发终态事件并关闭通道. */
  private async finishSafely(
    channel: TurnEventChannel<TurnStreamEvent>,
    writer: TurnMessageWriter,
    terminal: 'completed' | 'failed' | 'aborted',
    tools: TurnToolsAssembly | undefined,
    turn: Turn,
    signal: AbortSignal,
    handledGoalId: string | undefined,
    resolve: () => void,
    reject: (error: unknown) => void,
    emitTerminal?: () => void,
  ): Promise<void> {
    const { sessionId, id: turnId } = turn;
    let finishSucceeded = false;
    let finishError: unknown;
    try {
      await writer.finish(terminal);
      finishSucceeded = true;
    } catch (error) {
      finishError = error;
console.warn('[turn] 消息保存失败, 终态事件未广播:', error);
    }
    try {
      this.deps.interactionQueue.cancelForTurn(turnId, `turn ${terminal}`);
    } catch {
      // 队列清理失败不能覆盖终态.
    }
    if (tools) {
      try {
        await tools.shutdown(terminal);
      } catch {
        // 工具关闭失败不能覆盖终态.
      }
    }
    try {
      if (terminal !== 'completed' || signal.aborted || !finishSucceeded) {
        this.pauseHandledGoal(sessionId, handledGoalId);
      }
    } catch (error) {
      finishSucceeded = false;
      finishError = error;
    }
    // 收尾和 Goal 暂停先完成, 再解除占用. completion/终态事件不会暴露半收尾的 Session.
    this.runningTools.delete(turnId);
    this.runningCompletions.delete(turnId);
    this.deps.turns.clearRunning(sessionId, turnId);
    let continuationStatus = terminal;
    if (!finishSucceeded) continuationStatus = 'failed';
    else if (signal.aborted) continuationStatus = 'aborted';
    this.deps.continuations.workFinished(sessionId, continuationStatus);
    if (!finishSucceeded) {
      reject(finishError);
      channel.fail(finishError);
      return;
    }
    emitTerminal?.();
    resolve();
    channel.finish();
  }

  private pauseHandledGoal(sessionId: string, goalId: string | undefined): void {
    if (!goalId || !this.deps.goalStore) return;
    const goal = this.deps.goalStore.get(sessionId, goalId);
    if (goal?.status !== 'active') return;
    // feedback 和用户编辑都可能增加版本. 暂停同一目标的当前版本, 不影响后来新建的目标.
    this.deps.goalStore.pause({ sessionId, goalId, expectedVersion: goal.version });
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
}

/** Reminder 的用户文本只取显式正文, 不混入附件描述或 Skill 指引. */
function explicitUserText(blocks: MessageBlocks): string {
  if (typeof blocks === 'string') return blocks;
  return blocks
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('');
}

const AUTO_SESSION_TITLE_LENGTH = 30;
const IMAGE_SESSION_TITLE = '图片';
const FILE_SESSION_TITLE = '附件';
// 按完整可见字符截取, 不拆开组合 emoji 或带重音的字符.
const titleSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function createSessionTitle(blocks: MessageBlocks): string {
  let source: string;
  if (typeof blocks === 'string') {
    source = blocks;
  } else {
    const texts: string[] = [];
    const previews: string[] = [];
    const files: string[] = [];
    const skills: string[] = [];
    let imageCount = 0;
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          texts.push(block.text);
          break;
        case 'pasted_text_reference':
          previews.push(block.preview);
          break;
        case 'file_reference':
          files.push(block.path.split(/[\\/]/).pop() || FILE_SESSION_TITLE);
          break;
        case 'image_reference':
          imageCount += 1;
          break;
        case 'skill_reference':
          skills.push(block.name);
          break;
      }
    }
    source = texts.join(' ').trim() || previews.join(' ').trim();
    if (!source) {
      const attachmentCount = files.length + imageCount;
      if (files.length > 0) {
        source = files[0]!;
        if (attachmentCount > 1) {
          source = `${source} 等 ${attachmentCount} 个附件`;
        }
      } else if (imageCount > 0) {
        source = IMAGE_SESSION_TITLE;
        if (imageCount > 1) {
          source = `${imageCount} 张图片`;
        }
      } else if (skills.length > 0) {
        source = skills[0]!;
        if (skills.length > 1) {
          source = `${source} 等 ${skills.length} 个技能`;
        }
      }
    }
  }
  const normalized = source.replace(/\s+/gu, ' ').trim() || DEFAULT_SESSION_TITLE;
  let title = '';
  let length = 0;
  for (const part of titleSegmenter.segment(normalized)) {
    if (length === AUTO_SESSION_TITLE_LENGTH) break;
    title += part.segment;
    length += 1;
  }
  return title;
}

/**
 * 一次 Turn 或手动压缩共用一个 Map, 按需读取历史 Turn 的模型来源和对话角色.
 * 只读 loadHistory 实际交付的 Turn, 后续追加消息复用这份查询结果.
 * 角色使用当时保存的名字, 不查当前角色目录或参考音频; 缺失身份不猜测.
 */
export function createTurnHistoryResolver(
  turns: Pick<TurnStore, 'getTurn'>,
) {
  const cache = new Map<string, Turn | undefined>();
  const readTurn = (turnId: string): Turn | undefined => {
    if (!cache.has(turnId)) {
      cache.set(turnId, turns.getTurn(turnId));
    }
    return cache.get(turnId);
  };

  return {
    resolveGenerationSource(turnId: string): LLMGenerationSource | undefined {
      const turn = readTurn(turnId);
      // 没有完整模型身份时不伪造生成来源, 协议代码据此决定能否重放推理块.
      if (!turn?.providerId || !turn.modelId || !turn.protocol || !isLLMProtocol(turn.protocol)) {
        return undefined;
      }
      return {
        providerId: turn.providerId,
        modelId: turn.modelId,
        protocol: turn.protocol,
      };
    },
    resolveCharacter(turnId: string): string | undefined {
      return readTurn(turnId)?.characterName ?? undefined;
    },
  };
}

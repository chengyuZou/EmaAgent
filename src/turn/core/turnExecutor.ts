import { createTurnInputWriter } from './turnInputWriter.js';
import { createTurnHistoryResolver } from './turnHistoryResolver.js';
import { determineTurnOutcome, finishTurn } from './turnTermination.js';
import * as fs from 'node:fs';
import {
  runAgentLoop,
  ModelMessageIds,
  type AgentLoopEvent,
  type PrepareAgentIteration,
} from '@ema-agent/agent';
import type { VisionDescriptionCache } from '@ema-agent/attachments';
import { projectMessages } from '@ema-agent/context';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import type {
  CompleteLLM,
  Message,
} from '@ema-agent/llm';
import {
  type SessionStore,
} from '@ema-agent/session';
import type { StageEngine } from '@ema-agent/stage';
import type { Turn } from '../types.js';
import type { UsageRecorder } from '@ema-agent/usage';
import { TurnEventChannel } from './turnEventChannel.js';
import {
  failureCodeOf,
  failureMessageOf,
  TurnEventChannelClosedError,
} from '../errors.js';
import type { TurnStreamEvent } from '../events.js';
import { createPrepareAgentIteration } from '../prepare/prepareAgentIteration.js';
import { createPrepareSubagent } from '../subagent/prepareSubagent.js';
import { TurnMessageWriter } from './turnMessageWriter.js';
import { createForkParentMessages } from '../subagent/forkParentMessages.js';
import { createTurnLoopEvents } from './turnLoopEvents.js';
import {
  prepareTurn,
  type PreparedTurn,
  type PrepareTurnDeps,
} from '../prepare/prepareTurn.js';
import type { RenderTurnReminderInput } from '../reminder/turnReminder.js';
import type { TurnToolsAssembly } from '../tools/turnTools.js';
import type { TurnStore } from '../store/turnStore.js';
import type { SessionContinuationQueue } from '../continuation/sessionContinuationQueue.js';
import type {
  StartTurn,
  TurnHandle,
  TurnOutcome,
} from '../types.js';

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

    const completion = this.runTurn({ input, turn, signal, channel }).finally(() => {
      this.runningTools.delete(turn.id);
      this.runningCompletions.delete(turn.id);
    });
    // Server 消费事件流, completion 也保留给删除 Session 等等待收尾的调用方.
    void completion.catch(() => undefined);
    this.runningCompletions.set(turn.id, completion);

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

  private async runTurn(args: {
    input: StartTurn;
    turn: Turn;
    signal: AbortSignal;
    channel: TurnEventChannel<TurnStreamEvent>;
  }): Promise<TurnOutcome> {
    const { input, turn, signal, channel } = args;
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
    let outcome: TurnOutcome;
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

      const inputWriter = createTurnInputWriter(this.deps, {
        sessionId, turnId, signal, skillPool: prepared.skillPool, emit,
      });
      handledGoalId = await inputWriter.writeInitialInput(input, prepared.userMessageBlocks, characterName);

      // 历史, reminder 与本 Turn 用户输入按 SQL 顺序投影为同一条模型消息链.
      // 后续 Macro 可以覆盖完整有效前缀, 不再被 Turn 边界截断.
      const persisted = this.deps.sessions.loadHistory(sessionId);
      const historyResolver = createTurnHistoryResolver(this.deps.turns);
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
      );
      const initialMessages: Message[] = projected.map(entry => entry.message);
      // 保存模型历史每个位置对应的 Message ID, Macro 据此确定实际覆盖到哪条 SQL 消息.
      const messageIds = new ModelMessageIds(projected.map(entry => entry.messageId));

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
        forkParentMessages.beginRequest(iteration.messages, messageIds.values);
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
          const appended = await inputWriter.takeNextIterationMessages();
          const projected = await projectMessages(
            appended,
            message => message.turnId ? historyResolver.resolveGenerationSource(message.turnId) : undefined,
            attachmentOptions,
          );
          messageIds.queueSavedMessages(projected.map(entry => entry.messageId));
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
        messageIds.record(downstream, storedMessageId);
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
      outcome = determineTurnOutcome(turn, stopped, this.deps.goalStore?.getCurrent(sessionId), handledGoalId);
    } catch (error) {
      forkParentMessages.fail(error);
      this.deps.continuations.release(turnId);
      outcome = signal.aborted || error instanceof TurnEventChannelClosedError
        ? { status: 'aborted', sessionId, turnId, reason: 'user_stop' }
        : { status: 'failed', sessionId, turnId, code: failureCodeOf(error), message: failureMessageOf(error) };
    }

    try {
      const finished = await finishTurn(this.deps, {
        turn, signal, writer, tools, outcome, handledGoalId,
      });
      if (finished.status === 'completed') {
        emit({ type: 'turn_completed', sessionId, turnId });
      } else if (finished.status === 'aborted') {
        emit({ type: 'turn_aborted', sessionId, turnId, reason: finished.reason });
      } else {
        emit({ type: 'turn_failed', sessionId, turnId, code: finished.code, message: finished.message });
      }
      channel.finish();
      return finished;
    } catch (error) {
      channel.fail(error);
      throw error;
    } finally {
      if (prepared?.scratchpadDir) {
        const scratchpadDir = prepared.scratchpadDir;
        // 后台子代理仍可能使用此目录, 等最后一个派生执行结束再删除.
        void this.deps.subagents.waitForTurnSubagents(turnId).then(() => {
          try {
            fs.rmSync(scratchpadDir, { recursive: true, force: true });
          } catch {
            // 临时文件清理失败不改变已经保存的 Turn 结果.
          }
        });
      }
    }
  }
}

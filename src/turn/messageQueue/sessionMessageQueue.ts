import { randomUUID } from 'node:crypto';
import type { Goal, GoalStore } from '@ema-agent/goal';
import { logging } from '@ema-agent/logging';
import type { ImageReferenceBlock, SessionRunningRegistry, SessionStore } from '@ema-agent/session';
import type { StartTurn, TurnInputPart, TurnOutcome } from '../types.js';
import { buildQueueMessages } from './queueMessageContent.js';
import type {
  BackgroundCompletionInput,
  MessageReservation,
  PendingCompletionNotice,
  PendingGoalEdit,
  PendingQueuedInput,
  QueueMessage,
  QueuedSessionInput,
  SessionMessageQueueEvent,
} from './queueTypes.js';

/**
 * SessionMessageQueue 依赖的外部协作者.
 * `startTurn` 负责真正启动 Turn 并接入事件分发, 不能在调用栈内同步重入队列变更.
 * `publish` 向观察当前 Session 的前端增量同步排队用户输入状态.
 */
export interface SessionMessageQueueDeps {
  readonly sessions: Pick<SessionStore, 'getSession' | 'getSessionForWork' | 'sessionExists'>;
  readonly sessionRunning: Pick<SessionRunningRegistry, 'isRunning' | 'getRunning' | 'isClosed'>;
  readonly goals: Pick<GoalStore, 'getCurrent'>;
  readonly startTurn: (input: StartTurn) => void;
  readonly publish: (sessionId: string, event: SessionMessageQueueEvent) => void;
}

/**
 * 按 Session 统一管理当前进程内的排队用户输入, 后台完成通知,
 * 运行中 Goal 编辑提醒, 以及活跃 Goal 的自动下一轮续接.
 */
export class SessionMessageQueue {
  /** 按提交顺序保存尚未确认落库的用户输入; 调整为 `'next_iteration'` 不改变合并和退回草稿顺序. */
  private readonly pendingQueuedInputsBySession = new Map<string, PendingQueuedInput[]>();
  /** 当前进程内产生但尚未被模型读取的 Subagent/后台命令终态通知. */
  private readonly pendingCompletionNoticesBySession = new Map<string, PendingCompletionNotice[]>();
  /** 仅记录编辑发生时正在运行的那一轮 Turn 的 Goal 修改, 不唤醒空闲 Session. */
  private readonly pendingGoalEditsBySession = new Map<string, PendingGoalEdit>();
  /** 当前正在写库的唯一消息预留(按 `sessionId` 存储), 由 `confirmMessageSaved` 或 `releaseReservedMessage` 清理. */
  private readonly unconfirmedReservationsBySession = new Map<string, MessageReservation>();
  /** 已排入微任务或正在执行 `tryStartNextTurn` 的 Session, 防止同会话并发重复启动 Turn. */
  private readonly scheduledTurnStartSessions = new Set<string>();
  /** 应用关闭时置为 true, 阻断关闭数据库后的延迟微任务或后台回调继续启动 Turn. */
  private isShutdown = false;

  constructor(private readonly deps: SessionMessageQueueDeps) {}

  /** 在 Turn 运行期间记录活跃 Goal 编辑; Session 空闲, Goal 非活跃或队列已关闭时忽略. */
  notifyGoalEdited(goal: Goal): void {
    if (this.isShutdown || goal.status !== 'active') return;
    const running = this.deps.sessionRunning.getRunning(goal.sessionId);
    if (running?.kind !== 'turn') return;
    this.pendingGoalEditsBySession.set(goal.sessionId, {
      turnId: running.turnId,
      goalId: goal.id,
      version: goal.version,
    });
  }

  /**
   * 复制用户输入放入内存队列; 若当前 Session 空闲, 在当前调用栈结束后启动新 Turn.
   * 若 Session 不存在或已归档/禁止写入, `getSessionForWork` 会同步抛出对应错误.
   */
  enqueueUserMessage(sessionId: string, input: readonly TurnInputPart[]): QueuedSessionInput {
    this.deps.sessions.getSessionForWork(sessionId);
    const queuedInput: PendingQueuedInput = {
      id: randomUUID(),
      sessionId,
      input: structuredClone(input),
      createdAt: Date.now(),
      delivery: 'next_turn',
    };
    const sessionQueue = this.pendingQueuedInputsBySession.get(sessionId) ?? [];
    sessionQueue.push(queuedInput);
    this.pendingQueuedInputsBySession.set(sessionId, sessionQueue);
    this.deps.publish(sessionId, {
      type: 'queued_input_added',
      queuedInput: toPublicQueuedInput(queuedInput),
    });
    this.requestStartNextTurn(sessionId);
    return toPublicQueuedInput(queuedInput);
  }

  /**
   * 只有 Session 无运行中 Turn/压缩, 无待启动微任务, 无排队用户输入和后台通知,
   * 且当前无活跃 Goal 时才返回 true, 用于判断能否接收自动截图等空闲触发输入.
   */
  canAcceptIdleInput(sessionId: string): boolean {
    return this.acceptsWork(sessionId)
      && !this.deps.sessionRunning.isRunning(sessionId)
      && !this.scheduledTurnStartSessions.has(sessionId)
      && (this.pendingQueuedInputsBySession.get(sessionId)?.length ?? 0) === 0
      && (this.pendingCompletionNoticesBySession.get(sessionId)?.length ?? 0) === 0
      && this.deps.goals.getCurrent(sessionId)?.status !== 'active';
  }

  /**
   * 同步检查空闲条件并在满足时入队自动屏幕截图.
   * 检查与入队之间不能 await, 避免截屏等待期间用户已提交消息导致并发竞争.
   */
  enqueueScreenCaptureIfIdle(sessionId: string, image: ImageReferenceBlock): boolean {
    if (!this.canAcceptIdleInput(sessionId)) return false;
    this.enqueueUserMessage(sessionId, [{ type: 'attachment', block: image }]);
    return true;
  }

  /** 返回当前尚未确认落库的排队输入列表; 正在写库的预留项在确认完成前仍包含在内. */
  listQueuedInputs(sessionId: string): readonly QueuedSessionInput[] {
    return (this.pendingQueuedInputsBySession.get(sessionId) ?? []).map(toPublicQueuedInput);
  }

  /** 仅允许删除处于 `'next_turn'` 且尚未被 Turn 预留写入的排队输入, 防止 UI 与落库同时修改同一项. */
  removeQueuedInput(sessionId: string, queuedInputId: string): boolean {
    const sessionQueue = this.pendingQueuedInputsBySession.get(sessionId);
    const index = sessionQueue?.findIndex(item => (
      item.id === queuedInputId
      && item.delivery === 'next_turn'
      && !this.isQueuedInputReserved(sessionId, item.id)
    )) ?? -1;
    if (!sessionQueue || index < 0) return false;
    sessionQueue.splice(index, 1);
    if (sessionQueue.length === 0) {
      this.pendingQueuedInputsBySession.delete(sessionId);
    }
    this.deps.publish(sessionId, { type: 'queued_input_removed', queuedInputId });
    return true;
  }

  /**
   * 在 Turn 运行期间, 把尚未预留的 `'next_turn'` 排队输入升级为 `'next_iteration'`,
   * 使其可在 AgentLoop 的下一处安全迭代边界注入, 不直接打断正在流式生成的单次模型调用.
   */
  markInputForNextIteration(sessionId: string, queuedInputId: string): boolean {
    if (this.deps.sessionRunning.getRunning(sessionId)?.kind !== 'turn') return false;
    const sessionQueue = this.pendingQueuedInputsBySession.get(sessionId);
    const index = sessionQueue?.findIndex(item => (
      item.id === queuedInputId
      && item.delivery === 'next_turn'
      && !this.isQueuedInputReserved(sessionId, item.id)
    )) ?? -1;
    if (!sessionQueue || index < 0) return false;
    const queuedInput = sessionQueue[index]!;
    queuedInput.delivery = 'next_iteration';
    this.deps.publish(sessionId, {
      type: 'queued_input_delivery_changed',
      queuedInput: toPublicQueuedInput(queuedInput),
    });
    return true;
  }

  /** 为运行中的 Turn 在安全迭代边界预留下一批可注入消息(Goal 编辑, 后台完成通知, 或已标记插队的用户输入). */
  reserveNextIterationMessages(sessionId: string, turnId: string): readonly QueueMessage[] {
    return this.reserveNextMessagesForTurn(sessionId, turnId, { onlyNextIterationEligible: true });
  }

  /**
   * Turn 把预留消息成功写入 Messages 表后调用, 从内存队列删除已消费条目.
   * 若本次确认的是用户输入预留, 返回对应的 `queuedInputId` 列表随 `user_messages_stored` 广播给前端; 其他来源返回空数组.
   */
  confirmMessageSaved(sessionId: string, turnId: string): readonly string[] {
    const reservation = this.unconfirmedReservationsBySession.get(sessionId);
    if (!reservation || reservation.turnId !== turnId) return [];
    this.unconfirmedReservationsBySession.delete(sessionId);

    if (reservation.sourceType === 'goal_edit') {
      const pendingGoalEdit = this.pendingGoalEditsBySession.get(sessionId);
      // 保留写库期间新到达的更高版本或新轮次 Goal 编辑, 不被较早消息的确认清掉.
      if (
        pendingGoalEdit?.turnId === turnId
        && pendingGoalEdit.goalId === reservation.goalId
        && pendingGoalEdit.version === reservation.version
      ) {
        this.pendingGoalEditsBySession.delete(sessionId);
      }
      return [];
    }

    if (reservation.sourceType === 'user_inputs') {
      const remainingInputs = (this.pendingQueuedInputsBySession.get(sessionId) ?? [])
        .filter(item => !reservation.queuedInputIds.has(item.id));
      if (remainingInputs.length > 0) {
        this.pendingQueuedInputsBySession.set(sessionId, remainingInputs);
      } else {
        this.pendingQueuedInputsBySession.delete(sessionId);
      }
      return [...reservation.queuedInputIds];
    }

    const remainingNotices = (this.pendingCompletionNoticesBySession.get(sessionId) ?? [])
      .filter(notice => !reservation.completionNoticeKeys.has(notice.key));
    if (remainingNotices.length > 0) {
      this.pendingCompletionNoticesBySession.set(sessionId, remainingNotices);
    } else {
      this.pendingCompletionNoticesBySession.delete(sessionId);
    }
    return [];
  }

  /** 准备或写库失败时撤销 `turnId` 对应的未确认预留, 使原队列条目保持待消费状态. */
  releaseReservedMessage(sessionId: string, turnId: string): void {
    const reservation = this.unconfirmedReservationsBySession.get(sessionId);
    if (!reservation || reservation.turnId !== turnId) return;
    this.unconfirmedReservationsBySession.delete(sessionId);
  }

  /** 登记子代理或后台命令的轻量完成通知; 完整结果已先由执行方写入 SQL/日志. */
  notifyBackgroundCompleted(notice: BackgroundCompletionInput): void {
    if (notice.source === 'subagent_completed') {
      this.addCompletionNotice(notice.sessionId, {
        key: `subagent:${notice.subagentId}`,
        source: 'subagent_completed',
        subagentId: notice.subagentId,
        status: notice.status,
      });
      return;
    }
    this.addCompletionNotice(notice.sessionId, {
      key: `background_process:${notice.backgroundProcessId}`,
      source: 'background_process_completed',
      backgroundProcessId: notice.backgroundProcessId,
      status: notice.status,
    });
  }

  /** `SubagentAwait` 已直接取回该子代理完整终态时, 撤掉同一执行尚未注入模型的轻量完成通知. */
  removeSubagentCompletionNotice(sessionId: string, subagentId: string): void {
    const notices = this.pendingCompletionNoticesBySession.get(sessionId);
    if (!notices) return;
    const noticeKey = `subagent:${subagentId}`;
    const remainingNotices = notices.filter(notice => (
      notice.key !== noticeKey || this.isCompletionNoticeReserved(sessionId, notice.key)
    ));
    if (remainingNotices.length > 0) {
      this.pendingCompletionNoticesBySession.set(sessionId, remainingNotices);
    } else {
      this.pendingCompletionNoticesBySession.delete(sessionId);
    }
  }

  /**
   * Turn 或手动压缩释放运行占用后调用.
   * `'completed'` 继续调度后续排队工作或活跃 Goal 续接; `'failed'` 或 `'aborted'` 把未落库用户输入退回草稿, 不自动重试.
   */
  onSessionWorkFinished(sessionId: string, status: TurnOutcome['status']): void {
    this.pendingGoalEditsBySession.delete(sessionId);
    this.unconfirmedReservationsBySession.delete(sessionId);
    if (status === 'completed') {
      this.requestStartNextTurn(sessionId);
      return;
    }
    const returnedInputs = this.listQueuedInputs(sessionId);
    this.pendingQueuedInputsBySession.delete(sessionId);
    if (returnedInputs.length > 0) {
      this.deps.publish(sessionId, {
        type: 'queued_inputs_returned',
        queuedInputs: returnedInputs,
      });
    }
  }

  /** 归档或删除 Session 时清空该会话尚未执行的排队项, 通知, Goal 编辑和预留; 已持久化消息不受影响. */
  clearSession(sessionId: string): void {
    const removedInputs = this.pendingQueuedInputsBySession.get(sessionId) ?? [];
    this.pendingQueuedInputsBySession.delete(sessionId);
    this.pendingCompletionNoticesBySession.delete(sessionId);
    this.pendingGoalEditsBySession.delete(sessionId);
    this.unconfirmedReservationsBySession.delete(sessionId);
    for (const queuedInput of removedInputs) {
      this.deps.publish(sessionId, {
        type: 'queued_input_removed',
        queuedInputId: queuedInput.id,
      });
    }
  }

  /** 停机时先封住自动续接再关闭执行链, 防止数据库关闭后仍尝试启动新 Turn. */
  shutdown(): void {
    this.isShutdown = true;
    this.pendingQueuedInputsBySession.clear();
    this.pendingCompletionNoticesBySession.clear();
    this.pendingGoalEditsBySession.clear();
    this.unconfirmedReservationsBySession.clear();
  }

  /**
   * 请求在当前微任务后尝试启动下一轮 Turn(如果 Session 空闲且允许执行).
   * 排队入队, 后台通知到达, 创建/激活 Goal 以及手动压缩完成后都复用此入口.
   */
  requestStartNextTurn(sessionId: string): void {
    if (this.isShutdown || this.scheduledTurnStartSessions.has(sessionId) || this.deps.sessionRunning.isRunning(sessionId)) {
      return;
    }
    if (!this.acceptsWork(sessionId)) return;
    // 推迟到微任务执行, 避免 `startTurn` 在生产者或数据库回调栈内同步重入.
    this.scheduledTurnStartSessions.add(sessionId);
    queueMicrotask(() => {
      this.scheduledTurnStartSessions.delete(sessionId);
      this.tryStartNextTurn(sessionId);
    });
  }

  private tryStartNextTurn(sessionId: string): void {
    if (this.isShutdown || this.scheduledTurnStartSessions.has(sessionId) || this.deps.sessionRunning.isRunning(sessionId)) {
      return;
    }
    if (!this.acceptsWork(sessionId)) return;
    this.scheduledTurnStartSessions.add(sessionId);
    const turnId = randomUUID();
    try {
      // 先登记预留再调用 `startTurn`, 确保同步异常也能经由 `releaseReservedMessage` 退回草稿.
      const queueMessages = this.reserveNextMessagesForTurn(sessionId, turnId, {
        onlyNextIterationEligible: false,
      });
      if (queueMessages.length === 0) return;
      const session = this.deps.sessions.getSessionForWork(sessionId);
      this.deps.startTurn({
        turnId,
        sessionId,
        ttsEnabled: session.ttsEnabled,
        messages: queueMessages,
      });
    } catch (error) {
      this.releaseReservedMessage(sessionId, turnId);
      this.onSessionWorkFinished(sessionId, 'failed');
      logging({
        level: 'warn',
        target: 'turn',
        event: 'turn.queued_start_failed',
        error,
        body: { sessionId, turnId },
      });
    } finally {
      this.scheduledTurnStartSessions.delete(sessionId);
    }
  }

  private addCompletionNotice(sessionId: string, notice: PendingCompletionNotice): void {
    if (!this.acceptsWork(sessionId)) return;
    const notices = this.pendingCompletionNoticesBySession.get(sessionId) ?? [];
    if (!notices.some(existing => existing.key === notice.key)) {
      notices.push(notice);
    }
    this.pendingCompletionNoticesBySession.set(sessionId, notices);
    this.requestStartNextTurn(sessionId);
  }

  /**
   * 按优先级为 `turnId` 预留下一批待消费消息列表; 无可交付内容时返回空数组.
   * `onlyNextIterationEligible` 为 true(运行中轮次安全边界)时, 仅收取 `'next_iteration'` 用户输入, 且后台完成通知优先于用户输入.
   * 为 false(启动新 Turn)时, 优先按提交顺序取全部排队用户输入发起正常对话, 无用户输入时再发后台通知或续接活跃 Goal.
   */
  private reserveNextMessagesForTurn(
    sessionId: string,
    turnId: string,
    options: { readonly onlyNextIterationEligible: boolean },
  ): readonly QueueMessage[] {
    if (!this.acceptsWork(sessionId)) return [];
    if (this.unconfirmedReservationsBySession.has(sessionId)) return [];

    const { onlyNextIterationEligible } = options;
    const pendingGoalEdit = this.pendingGoalEditsBySession.get(sessionId);
    if (onlyNextIterationEligible && pendingGoalEdit?.turnId === turnId) {
      const goal = this.deps.goals.getCurrent(sessionId);
      if (goal?.id === pendingGoalEdit.goalId && goal.status === 'active') {
        this.unconfirmedReservationsBySession.set(sessionId, {
          turnId,
          sourceType: 'goal_edit',
          goalId: pendingGoalEdit.goalId,
          version: pendingGoalEdit.version,
        });
        return buildQueueMessages({ kind: 'goal_edit', goal });
      }
      this.pendingGoalEditsBySession.delete(sessionId);
    }

    const eligibleUserInputs = (this.pendingQueuedInputsBySession.get(sessionId) ?? []).filter(item => (
      !onlyNextIterationEligible || item.delivery === 'next_iteration'
    ));
    // 后台完成通知只在当前进程内单次交付; 重启后模型仍可按 ID 主动读取完整 SQL/日志.
    const pendingNotices = this.pendingCompletionNoticesBySession.get(sessionId) ?? [];

    // 轮中安全边界优先消化后台完成通知再注入用户插队; 空闲启动新 Turn 则让用户输入优先触发本轮对话.
    if (pendingNotices.length > 0 && (onlyNextIterationEligible || eligibleUserInputs.length === 0)) {
      this.unconfirmedReservationsBySession.set(sessionId, {
        turnId,
        sourceType: 'completion_notices',
        completionNoticeKeys: new Set(pendingNotices.map(notice => notice.key)),
      });
      return buildQueueMessages({ kind: 'completion_notices', notices: pendingNotices });
    }

    if (eligibleUserInputs.length === 0) {
      if (onlyNextIterationEligible) return [];
      const goal = this.deps.goals.getCurrent(sessionId);
      if (goal?.status !== 'active') return [];
      // TODO: 自动续接前检查持久化的 Goal 总预算, 避免跨 Turn 无限自动续跑.
      return buildQueueMessages({ kind: 'goal_continue' });
    }

    this.unconfirmedReservationsBySession.set(sessionId, {
      turnId,
      sourceType: 'user_inputs',
      queuedInputIds: new Set(eligibleUserInputs.map(item => item.id)),
    });
    return buildQueueMessages({ kind: 'user_inputs', queuedInputs: eligibleUserInputs });
  }

  private isQueuedInputReserved(sessionId: string, queuedInputId: string): boolean {
    const reservation = this.unconfirmedReservationsBySession.get(sessionId);
    return reservation?.sourceType === 'user_inputs' && reservation.queuedInputIds.has(queuedInputId);
  }

  private isCompletionNoticeReserved(sessionId: string, noticeKey: string): boolean {
    const reservation = this.unconfirmedReservationsBySession.get(sessionId);
    return reservation?.sourceType === 'completion_notices' && reservation.completionNoticeKeys.has(noticeKey);
  }

  private acceptsWork(sessionId: string): boolean {
    if (this.isShutdown || this.deps.sessionRunning.isClosed(sessionId)) return false;
    if (!this.deps.sessions.sessionExists(sessionId)) return false;
    return this.deps.sessions.getSession(sessionId).archivedAt === null;
  }
}

/** 构造发布给前端与调用方的公开排队条目快照, 不暴露内部可变对象引用. */
function toPublicQueuedInput(queuedInput: PendingQueuedInput): QueuedSessionInput {
  return {
    id: queuedInput.id,
    sessionId: queuedInput.sessionId,
    input: queuedInput.input,
    createdAt: queuedInput.createdAt,
    delivery: queuedInput.delivery,
  };
}

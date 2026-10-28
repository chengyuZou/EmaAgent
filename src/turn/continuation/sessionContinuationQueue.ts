import type { SubagentStatus } from '@ema-agent/agent';
import type {
  ClaimedSessionContinuation,
  CompletionNotice,
  ContinuationClaim,
  EnqueueSessionInput,
  PendingInput,
  QueuedSessionInput,
  SessionContinuationEvent,
} from './continuationTypes.js';
import { formatCompletionNoticeText, mergeQueuedInput, GOAL_CONTINUATION_TEXT } from './continuationText.js';
import { randomUUID } from 'node:crypto';
import type { Goal, GoalStore } from '@ema-agent/goal';
import type { SessionRunningRegistry, SessionStore } from '@ema-agent/session';
import type { BackgroundProcessNotifiableStatus } from '@ema-agent/tools';
import type {
  StartTurn,
  TurnHandle,
  TurnOutcome,
} from '../types.js';
import { renderGoalEditReminder } from '../reminder/turnReminder.js';

/**
 * SessionStore 提供会话事实, SessionRunningRegistry 提供 Turn 或手动压缩的运行身份.
 * startTurn 与 attachTurn 负责真正启动执行并接入事件消费; publish 只同步前端队列状态.
 */
export interface SessionContinuationQueueDeps {
  readonly sessions: Pick<SessionStore, 'getSession' | 'getSessionForWork' | 'sessionExists'>;
  readonly sessionRunning: Pick<SessionRunningRegistry, 'isRunning' | 'getRunning' | 'isClosed'>;
  readonly goals: Pick<GoalStore, 'getCurrent'>;
  readonly startTurn: (input: StartTurn) => TurnHandle;
  readonly attachTurn: (handle: TurnHandle) => void;
  readonly publish: (sessionId: string, event: SessionContinuationEvent) => void;
}

/**
 * 队列只保存当前进程还没交付的输入和轻量完成通知. Subagent 与后台命令的完整结果
 * 由各自的 SQL/日志保存, 模型需要详情时按通知中的 id 调 SubagentAwait 或 ProcessOutput.
 */
export class SessionContinuationQueue {
  /** 输入保持提交顺序, 改为引导不改变合并或退回草稿时的顺序. */
  private readonly inputs = new Map<string, PendingInput[]>();
  /** 当前进程产生但尚未交付模型的后台终态通知. */
  private readonly completionNotices = new Map<string, CompletionNotice[]>();
  /** 只绑定编辑发生时的 Turn, 不唤醒空闲 Session 或留给后来 Turn. */
  private readonly goalEdits = new Map<string, {
    readonly turnId: string;
    readonly goalId: string;
    readonly version: number;
  }>();
  /** 已被 Turn 暂时占用的输入和通知, 是 acknowledge/release 的依据. */
  private readonly claims = new Map<string, ContinuationClaim>();
  /** 防止同一 Session 被多个微任务重复启动 Turn. */
  private readonly draining = new Set<string>();
  private stopped = false;

  constructor(private readonly deps: SessionContinuationQueueDeps) {}

  /** 正文提交事件不是用户 Queue card. 同一安全点前多次编辑只交付最新 SQL 事实. */
  goalEdited(goal: Goal): void {
    if (this.stopped || goal.status !== 'active') return;
    const running = this.deps.sessionRunning.getRunning(goal.sessionId);
    if (running?.kind !== 'turn') return;
    this.goalEdits.set(goal.sessionId, {
      turnId: running.turnId,
      goalId: goal.id,
      version: goal.version,
    });
  }

  /**
   * 入队时复制输入, 避免前端草稿或调用方对象随后变化影响已经排队的内容.
   * 若 Session 当前空闲, 在同一调用栈结束后合并待处理输入并启动 Turn.
   */
  enqueue(input: EnqueueSessionInput): QueuedSessionInput {
    this.deps.sessions.getSessionForWork(input.sessionId);
    const item: PendingInput = {
      id: randomUUID(),
      sessionId: input.sessionId,
      input: structuredClone(input.input),
      createdAt: Date.now(),
      delivery: 'after_turn',
    };
    const items = this.inputs.get(input.sessionId) ?? [];
    items.push(item);
    this.inputs.set(input.sessionId, items);
    this.deps.publish(input.sessionId, { type: 'queued_input_added', item: publicItem(item) });
    this.requestDrain(input.sessionId);
    return publicItem(item);
  }

  canStartIdleTurn(sessionId: string): boolean {
    return this.acceptsWork(sessionId)
      && !this.deps.sessionRunning.isRunning(sessionId)
      && !this.draining.has(sessionId)
      && (this.inputs.get(sessionId)?.length ?? 0) === 0
      && (this.completionNotices.get(sessionId)?.length ?? 0) === 0
      && this.deps.goals.getCurrent(sessionId)?.status !== 'active';
  }

  enqueueIfIdle(input: EnqueueSessionInput): boolean {
    if (!this.canStartIdleTurn(input.sessionId)) return false;
    // 检查与入队之间不能 await, 否则可能出现 检查截屏-用户消息先入队-截屏入队.
    this.enqueue(input);
    return true;
  }

  /** 返回未确认消费的公开队列列表. 已领取项仍保留到 Message 落库完成. */
  list(sessionId: string): readonly QueuedSessionInput[] {
    return (this.inputs.get(sessionId) ?? []).map(publicItem);
  }

  /** 用户只能删除尚未被 Turn 领取的卡片, 避免 UI 删除与 Message 写库同时改动同一项. */
  remove(sessionId: string, id: string): boolean {
    const items = this.inputs.get(sessionId);
    const index = items?.findIndex(item => (
      item.id === id
      && item.delivery === 'after_turn'
      && item.claimedByTurnId === undefined
    )) ?? -1;
    if (!items || index < 0) return false;
    items.splice(index, 1);
    if (items.length === 0) this.inputs.delete(sessionId);
    this.deps.publish(sessionId, { type: 'queued_input_removed', id });
    return true;
  }

  /** 把尚未领取的普通排队输入改为下一次安全迭代边界交付, 不直接打断正在生成的 LLM. */
  guide(sessionId: string, id: string): boolean {
    if (this.deps.sessionRunning.getRunning(sessionId)?.kind !== 'turn') return false;
    const items = this.inputs.get(sessionId);
    const index = items?.findIndex(item => (
      item.id === id
      && item.delivery === 'after_turn'
      && item.claimedByTurnId === undefined
    )) ?? -1;
    if (!items || index < 0) return false;
    const item = items[index]!;
    item.delivery = 'next_iteration';
    this.deps.publish(sessionId, { type: 'queued_input_guided', item: publicItem(item) });
    return true;
  }

  /**
   * AgentLoop 只在 Assistant 和整批 ToolResult 都已完成后再调用这里. 普通排队输入
   * 留给下一个 Turn; 正文编辑, 立即引导和此刻已完成的后台通知可进入当前循环.
   */
  claimNextIteration(sessionId: string, turnId: string): ClaimedSessionContinuation | undefined {
    return this.claim(sessionId, turnId, true);
  }

  /** Message 落库后确认领取, 返回的输入 ID 随正式消息一起通知前端. */
  acknowledge(turnId: string): readonly string[] {
    const claim = this.claims.get(turnId);
    if (!claim) return [];
    this.claims.delete(turnId);
    if (claim.type === 'goal_edit') {
      const pending = this.goalEdits.get(claim.sessionId);
      // 写入期间后到的编辑不能被较早 Message 的确认吞掉.
      if (pending?.turnId === turnId && pending.goalId === claim.goalId && pending.version === claim.version) {
        this.goalEdits.delete(claim.sessionId);
      }
      return [];
    }
    if (claim.type === 'user_input') {
      const consumedIds = new Set(claim.userInputIds);
      const remainingInputs = (this.inputs.get(claim.sessionId) ?? []).filter(item => (
        !consumedIds.has(item.id)
      ));
      if (remainingInputs.length > 0) this.inputs.set(claim.sessionId, remainingInputs);
      else this.inputs.delete(claim.sessionId);
      return claim.userInputIds;
    }

    const noticeKeys = new Set(claim.completionNoticeKeys);
    const remainingNotices = (this.completionNotices.get(claim.sessionId) ?? [])
      .filter(notice => !noticeKeys.has(notice.key));
    if (remainingNotices.length > 0) this.completionNotices.set(claim.sessionId, remainingNotices);
    else this.completionNotices.delete(claim.sessionId);
    return [];
  }

  /** 撤销尚未保存的领取. 停止或失败时, workFinished 将这些用户输入一起退回草稿. */
  release(turnId: string): void {
    const claim = this.claims.get(turnId);
    if (!claim) return;
    this.claims.delete(turnId);
    if (claim.type === 'goal_edit') return;
    if (claim.type === 'user_input') {
      for (const item of this.inputs.get(claim.sessionId) ?? []) {
        if (item.claimedByTurnId === turnId) {
          item.claimedByTurnId = undefined;
        }
      }
      return;
    }

    const noticeKeys = new Set(claim.completionNoticeKeys);
    for (const notice of this.completionNotices.get(claim.sessionId) ?? []) {
      if (noticeKeys.has(notice.key) && notice.claimedByTurnId === turnId) notice.claimedByTurnId = undefined;
    }
  }

  /** SubagentExecutor 已先持久化终态, 此处只把轻量通知加入所属 Session. */
  subagentCompleted(
    sessionId: string,
    subagentId: string,
    status: Exclude<SubagentStatus, 'running'>,
  ): void {
    this.addCompletionNotice(sessionId, {
      key: `subagent:${subagentId}`,
      kind: 'subagent',
      id: subagentId,
      status,
    });
  }

  /** SubagentAwait 已取得完整终态时, 撤掉尚未注入模型的同一条轻量通知. */
  subagentResultRead(sessionId: string, subagentId: string): void {
    const notices = this.completionNotices.get(sessionId);
    if (!notices) return;
    const key = `subagent:${subagentId}`;
    const remaining = notices.filter(notice => (
      notice.key !== key || notice.claimedByTurnId !== undefined
    ));
    if (remaining.length > 0) this.completionNotices.set(sessionId, remaining);
    else this.completionNotices.delete(sessionId);
  }

  /** 后台命令已先完成日志与终态记录, 此处只把轻量通知加入所属 Session. */
  backgroundProcessCompleted(
    sessionId: string,
    backgroundProcessId: string,
    status: BackgroundProcessNotifiableStatus,
  ): void {
    this.addCompletionNotice(sessionId, {
      key: `background_process:${backgroundProcessId}`,
      kind: 'background_process',
      id: backgroundProcessId,
      status,
    });
  }

  /**
   * Turn 或手动压缩完成收尾并解除占用后调用. 正常完成继续执行,
   * 停止或失败将未保存的用户输入退回草稿, 不自动重试.
   */
  workFinished(sessionId: string, status: TurnOutcome['status']): void {
    this.goalEdits.delete(sessionId);
    if (status === 'completed') {
      this.requestDrain(sessionId);
      return;
    }
    const items = this.list(sessionId);
    this.inputs.delete(sessionId);
    for (const [turnId, claim] of this.claims) {
      if (claim.sessionId === sessionId && claim.type === 'user_input') {
        this.claims.delete(turnId);
      }
    }
    if (items.length > 0) {
      this.deps.publish(sessionId, { type: 'queued_inputs_returned', items });
    }
  }

  /** 删除或归档时取消尚未执行的输入和续接, 已经保存的 Message 不受影响. */
  clearSession(sessionId: string): void {
    const items = this.inputs.get(sessionId) ?? [];
    this.inputs.delete(sessionId);
    this.completionNotices.delete(sessionId);
    this.goalEdits.delete(sessionId);
    for (const [turnId, claim] of this.claims) {
      if (claim.sessionId === sessionId) this.claims.delete(turnId);
    }
    for (const item of items) {
      this.deps.publish(sessionId, { type: 'queued_input_removed', id: item.id });
    }
  }

  /** 应用关闭先封住自动续接再停止执行链, 防止数据库关闭后又启动新 Turn. */
  shutdown(): void {
    this.stopped = true;
    this.inputs.clear();
    this.completionNotices.clear();
    this.goalEdits.clear();
    this.claims.clear();
  }

  /** 同一后台执行只保留一条未交付通知; 已删除的 Session 不再触发模型调用. */
  private addCompletionNotice(sessionId: string, notice: CompletionNotice): void {
    if (!this.acceptsWork(sessionId)) return;
    const notices = this.completionNotices.get(sessionId) ?? [];
    if (!notices.some(existing => existing.key === notice.key)) notices.push(notice);
    this.completionNotices.set(sessionId, notices);
    this.requestDrain(sessionId);
  }

  /** 只请求重新领取消息, 创建/激活 Goal 或手动 Compact 解锁也使用这个入口. */
  requestDrain(sessionId: string): void {
    if (this.stopped || this.draining.has(sessionId) || this.deps.sessionRunning.isRunning(sessionId)) return;
    if (!this.acceptsWork(sessionId)) return;
    // 推到微任务后再启动, 避免 startTurn 在生产者的终态回调栈内重入.
    this.draining.add(sessionId);
    queueMicrotask(() => {
      this.draining.delete(sessionId);
      this.drain(sessionId);
    });
  }

  private drain(sessionId: string): void {
    if (this.stopped || this.draining.has(sessionId) || this.deps.sessionRunning.isRunning(sessionId)) return;
    if (!this.acceptsWork(sessionId)) return;
    this.draining.add(sessionId);
    const turnId = randomUUID();
    try {
      // 先领取再启动, 使同步抛错也能通过 release 把整批内容原样归还.
      const claim = this.claim(sessionId, turnId, false);
      if (!claim) return;
      const session = this.deps.sessions.getSessionForWork(sessionId);
      // 用户输入合为一条 Message. 内部通知与 Goal 续接不触发用户消息的标题生成.
      // 排队项不保留旧 TTS 选择. 启动时从 Session 偏好复制到 Turn, 后续只读 Turn 冻结值.
      const handle = this.deps.startTurn({
        turnId,
        sessionId,
        triggerType: claim.inputKind === 'messageInput' ? 'userMessage' : 'sessionContinuation',
        ttsEnabled: session.ttsEnabled,
        input: claim.inputKind === 'messageInput' ? claim.input : [],
        ...(claim.continuationText
          ? { continuationText: claim.continuationText }
          : {}),
      });
      this.deps.attachTurn(handle);
    } catch (error) {
      this.release(turnId);
      this.workFinished(sessionId, 'failed');
      console.warn('[continuation] Session 续接启动失败:', error);
    } finally {
      this.draining.delete(sessionId);
    }
  }

  /**
   * nextIterationOnly 为 true 时, 用户输入只能领取 delivery='next_iteration' 的立即引导项.
   * 为 false 时, 合并领取当前全部未消费的用户输入.
   * 后台完成通知使用下方的独立顺序, 不受该参数过滤.
   */
  private claim(
    sessionId: string,
    turnId: string,
    nextIterationOnly: boolean,
  ): ClaimedSessionContinuation | undefined {
    if (!this.acceptsWork(sessionId)) return undefined;
    if (this.claims.has(turnId)) return undefined;
    const edit = this.goalEdits.get(sessionId);
    if (nextIterationOnly && edit?.turnId === turnId) {
      const goal = this.deps.goals.getCurrent(sessionId);
      if (goal?.id === edit.goalId && goal.status === 'active') {
        this.claims.set(turnId, {
          type: 'goal_edit',
          sessionId,
          goalId: edit.goalId,
          version: edit.version,
        });
        return { inputKind: 'continuationText', continuationText: renderGoalEditReminder(goal) };
      }
      this.goalEdits.delete(sessionId);
    }
    const userInputs = (this.inputs.get(sessionId) ?? []).filter(item => (
      item.claimedByTurnId === undefined
      && (!nextIterationOnly || item.delivery === 'next_iteration')
    ));
    // 后台终态只在当前进程内投递一次. 断电后的完整结果仍可由模型按 id 主动读取,
    // 但应用启动不会因此擅自创建新 Turn 或调用模型.
    const notices = (this.completionNotices.get(sessionId) ?? [])
      .filter(notice => notice.claimedByTurnId === undefined);
    // 迭代安全点先交付后台终态, 再交付用户引导. 新 Turn 则由用户输入
    // 优先取得执行身份, 后台通知在 Turn 启动后的首个安全点继续领取.
    if (notices.length > 0 && (nextIterationOnly || userInputs.length === 0)) {
      for (const notice of notices) notice.claimedByTurnId = turnId;
      this.claims.set(turnId, {
        type: 'completion_notices',
        sessionId,
        completionNoticeKeys: notices.map(notice => notice.key),
      });
      return {
        inputKind: 'continuationText',
        continuationText: formatCompletionNoticeText(notices),
      };
    }
    if (userInputs.length === 0) {
      if (nextIterationOnly) return undefined;
      const goal = this.deps.goals.getCurrent(sessionId);
      if (goal?.status !== 'active') return undefined;
      // TODO: 自动续接前检查持久化的 Goal 总预算. 单 Turn 的 iter 切分
      // 不重置总预算, 耗尽不代表成功; 所有实际模型调用还需要同一预算准入检查.
      // Goal 是持续消息来源, 不复制正文或永久入队; 下一次领取重新读取 SQL.
      return {
        inputKind: 'continuationText',
        continuationText: GOAL_CONTINUATION_TEXT,
      };
    }

    for (const item of userInputs) item.claimedByTurnId = turnId;
    this.claims.set(turnId, {
      type: 'user_input',
      sessionId,
      userInputIds: userInputs.map(item => item.id),
    });
    const goal = nextIterationOnly ? null : this.deps.goals.getCurrent(sessionId);
    return {
      inputKind: 'messageInput',
      input: mergeQueuedInput(userInputs),
      ...(goal?.status === 'active' ? { continuationText: GOAL_CONTINUATION_TEXT } : {}),
    };
  }
  
  private acceptsWork(sessionId: string): boolean {
    if (this.stopped || this.deps.sessionRunning.isClosed(sessionId)) return false;
    if (!this.deps.sessions.sessionExists(sessionId)) return false;
    return this.deps.sessions.getSession(sessionId).archivedAt === null;
  }
}

/** 领取标记只用于服务端处理, 不属于前端队列条目. */
function publicItem(item: PendingInput): QueuedSessionInput {
  const { claimedByTurnId: _claimedByTurnId, ...visible } = item;
  return visible;
}


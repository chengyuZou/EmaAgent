// 按 Session 串联用户排队输入和本进程后台终态, 并只在 Agent 的安全边界交付给模型.

import { randomUUID } from 'node:crypto';
import type { SubagentStatus } from '@ema-agent/agent';
import type { SessionStore } from '@ema-agent/session';
import type { BackgroundProcessNotifiableStatus } from '@ema-agent/tools';
import type {
  StartTurn,
  TurnHandle,
  TurnInputPart,
  TurnKnowledgeSelection,
} from './types.js';
import type { TurnStore } from './turnStore.js';

/**
 * 自动续接只保留本次输入范围和朗读选择. 模型与推理强度每次从 Session 读取,
 * 否则设置窗口或输入区改过模型后, 内存里的旧选择会覆盖已保存的 Session.
 */
export interface SessionTurnSelection {
  readonly sessionMode: StartTurn['sessionMode'];
  readonly narrativePolicy: StartTurn['narrativePolicy'];
  readonly knowledge?: TurnKnowledgeSelection;
}

/** WebSocket queue_user_message 交给队列的完整业务输入. 内容此时只进入进程内存, 尚未写入 Message. */
export interface EnqueueSessionInput {
  readonly sessionId: string;
  readonly input: readonly TurnInputPart[];
  readonly selection: SessionTurnSelection;
}

/**
 * 前端队列卡片和 WebSocket 事件共用的公开投影.
 * after_turn 等当前 Turn 完整结束后另起 Turn; next_iteration 只在 AgentLoop 的安全迭代边界注入.
 */
export interface QueuedSessionInput {
  readonly id: string;
  readonly sessionId: string;
  readonly input: readonly TurnInputPart[];
  readonly createdAt: number;
  readonly delivery: 'after_turn' | 'next_iteration';
}

/**
 * Session WebSocket 的队列增量协议. 连接时的当前列表随 session_state 发送,
 * added/removed/guided 只表示已连接期间的变化.
 */
export type SessionContinuationEvent =
  | { readonly type: 'queued_input_added'; readonly item: QueuedSessionInput }
  | { readonly type: 'queued_input_removed'; readonly id: string }
  | { readonly type: 'queued_input_guided'; readonly item: QueuedSessionInput };

/**
 * Turn 从队列临时领取的内容. 领取不等于消费: 调用方写完 Message 后必须 acknowledge,
 * 准备或写库失败则必须 release, 这样输入和后台通知才不会静默丢失.
 */
export type ClaimedSessionContinuation =
  | {
      readonly type: 'user_input';
      readonly turnId: string;
      readonly userInput: QueuedSessionInput;
    }
  | {
      readonly type: 'completion_notices';
      readonly turnId: string;
      readonly completionNoticeText: string;
    };

/** 队列内部条目. claimedByTurnId 存在时禁止删除、改为引导或被另一根 Turn 重复领取. */
interface PendingInput extends Omit<QueuedSessionInput, 'delivery'> {
  delivery: QueuedSessionInput['delivery'];
  claimedByTurnId?: string;
}

/**
 * 后台完成通知只携带执行身份和终态, 不复制完整输出.
 * 分为子代理和后台Process两类, 但都只在当前进程内投递一次.
 * key 统一两类执行的去重身份; 完整结果分别留在 Subagent SQL 和后台进程日志中.
 */
type CompletionNotice =
  | {
      readonly key: string;
      readonly kind: 'subagent';
      readonly id: string;
      readonly status: Exclude<SubagentStatus, 'running'>;
      claimedByTurnId?: string;
    }
  | {
      readonly key: string;
      readonly kind: 'background_process';
      readonly id: string;
      readonly status: BackgroundProcessNotifiableStatus;
      claimedByTurnId?: string;
    };

/** 一次领取的反向索引. 用户输入和后台通知互斥, 一次确认只对应一条持久化 Message. */
type ContinuationClaim =
  | {
      readonly type: 'user_input';
      readonly sessionId: string;
      readonly userInputId: string;
    }
  | {
      readonly type: 'completion_notices';
      readonly sessionId: string;
      readonly completionNoticeKeys: readonly string[];
    };

/**
 * 队列依赖由 Server Composition 装配. Session/Turn Store 提供权威存在性和忙碌状态;
 * startTurn 与 attachTurn 负责真正启动执行并接入事件消费; publish 只同步前端队列状态.
 */
export interface SessionContinuationQueueDeps {
  readonly sessions: Pick<SessionStore, 'getSession' | 'sessionExists'>;
  readonly turns: Pick<TurnStore, 'getRunningTurn'>;
  readonly startTurn: (input: StartTurn) => TurnHandle;
  readonly attachTurn: (handle: TurnHandle, ttsEnabled: boolean) => void;
  readonly publish: (sessionId: string, event: SessionContinuationEvent) => void;
}

/**
 * 队列只保存当前进程还没交付的输入和轻量完成通知. Subagent 与后台命令的完整结果
 * 由各自的 SQL/日志保存, 模型需要详情时按通知中的 id 调 SubagentAwait 或 ProcessOutput.
 */
export class SessionContinuationQueue {
  /** 每个 Session 尚未确认消费的用户输入. guided 内部按引导成功顺序, 普通项保持入队顺序. */
  private readonly inputs = new Map<string, PendingInput[]>();
  /** 每个 Session 最近一次输入区选择, 供后续自动 Turn 使用. */
  private readonly selections = new Map<string, SessionTurnSelection>();
  /** 当前进程产生但尚未交付模型的后台终态通知. */
  private readonly completionNotices = new Map<string, CompletionNotice[]>();
  /** 已被 Turn 暂时占用的输入和通知, 是 acknowledge/release 的依据. */
  private readonly claims = new Map<string, ContinuationClaim>();
  /** 防止同一 Session 被多个微任务重复启动 Turn. */
  private readonly draining = new Set<string>();
  private stopped = false;

  constructor(private readonly deps: SessionContinuationQueueDeps) {}

  /**
   * 入队时冻结输入与选择, 避免前端草稿或调用方对象随后变化影响已经排队的内容.
   * 若 Session 当前空闲, requestDrain 会在同一调用栈结束后启动这一条输入的 Turn.
   */
  enqueue(input: EnqueueSessionInput): QueuedSessionInput {
    this.deps.sessions.getSession(input.sessionId);
    this.selections.set(input.sessionId, structuredClone(input.selection));
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
    const items = this.inputs.get(sessionId);
    const index = items?.findIndex(item => (
      item.id === id
      && item.delivery === 'after_turn'
      && item.claimedByTurnId === undefined
    )) ?? -1;
    if (!items || index < 0) return false;
    const [item] = items.splice(index, 1);
    if (!item) return false;
    item.delivery = 'next_iteration';
    // guided 项重新追加后, 对 guided 的过滤顺序就是后端确认的引导成功顺序.
    items.push(item);
    this.deps.publish(sessionId, { type: 'queued_input_guided', item: publicItem(item) });
    return true;
  }

  /**
   * AgentLoop 只在 Assistant 和整批 ToolResult 都已完成后再调用这里. 普通排队输入
   * 留给下一个 Turn, 只有立即引导和此刻已完成的后台通知可进入当前循环.
   */
  claimNextIteration(sessionId: string, turnId: string): ClaimedSessionContinuation | undefined {
    return this.claim(sessionId, turnId, true);
  }

  /** Message 已落库后才确认领取, 防止投影或写库失败时静默吞掉队列项. */
  acknowledge(turnId: string): void {
    const claim = this.claims.get(turnId);
    if (!claim) return;
    this.claims.delete(turnId);
    if (claim.type === 'user_input') {
      const claimedInput = (this.inputs.get(claim.sessionId) ?? []).find(item => (
        item.id === claim.userInputId && item.claimedByTurnId === turnId
      ));
      const remainingInputs = (this.inputs.get(claim.sessionId) ?? []).filter(item => (
        item.id !== claim.userInputId || item.claimedByTurnId !== turnId
      ));
      if (remainingInputs.length > 0) this.inputs.set(claim.sessionId, remainingInputs);
      else this.inputs.delete(claim.sessionId);
      if (claimedInput?.delivery === 'after_turn') {
        this.deps.publish(claim.sessionId, { type: 'queued_input_removed', id: claimedInput.id });
      }
      return;
    }

    const noticeKeys = new Set(claim.completionNoticeKeys);
    const remainingNotices = (this.completionNotices.get(claim.sessionId) ?? [])
      .filter(notice => !noticeKeys.has(notice.key));
    if (remainingNotices.length > 0) this.completionNotices.set(claim.sessionId, remainingNotices);
    else this.completionNotices.delete(claim.sessionId);
  }

  /** Turn 准备、附件处理或 Message 写库失败时撤销领取, 原内容继续留在队列等待下次交付. */
  release(turnId: string): void {
    const claim = this.claims.get(turnId);
    if (!claim) return;
    this.claims.delete(turnId);
    if (claim.type === 'user_input') {
      for (const item of this.inputs.get(claim.sessionId) ?? []) {
        if (item.id === claim.userInputId && item.claimedByTurnId === turnId) {
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
   * 必须在 TurnStore.clearRunning 之后调用. completion Promise 会先于 finally 清理完成,
   * 若从 Promise 回调唤醒, requestDrain 会把仍然 active 的 Session 当成忙碌而丢掉唤醒.
   */
  turnCompleted(sessionId: string): void {
    this.requestDrain(sessionId);
  }

  /** Session 删除流程在数据库删行前调用, 丢弃只属于该 Session 的全部进程内续接状态. */
  discardSession(sessionId: string): void {
    this.inputs.delete(sessionId);
    this.selections.delete(sessionId);
    this.completionNotices.delete(sessionId);
    for (const [turnId, claim] of this.claims) {
      if (claim.sessionId === sessionId) this.claims.delete(turnId);
    }
  }

  /** 应用关闭先封住自动续接再停止执行链, 防止数据库关闭后又启动新 Turn. */
  shutdown(): void {
    this.stopped = true;
    this.inputs.clear();
    this.selections.clear();
    this.completionNotices.clear();
    this.claims.clear();
  }

  /** 同一后台执行只保留一条未交付通知; 已删除的 Session 不再触发模型调用. */
  private addCompletionNotice(sessionId: string, notice: CompletionNotice): void {
    if (this.stopped || !this.deps.sessions.sessionExists(sessionId)) return;
    const notices = this.completionNotices.get(sessionId) ?? [];
    if (!notices.some(existing => existing.key === notice.key)) notices.push(notice);
    this.completionNotices.set(sessionId, notices);
    this.requestDrain(sessionId);
  }

  private requestDrain(sessionId: string): void {
    if (this.stopped || this.draining.has(sessionId) || this.deps.turns.getRunningTurn(sessionId)) return;
    // 推到微任务后再启动, 避免 startTurn 在生产者的终态回调栈内重入.
    queueMicrotask(() => this.drain(sessionId));
  }

  private drain(sessionId: string): void {
    if (this.stopped || this.draining.has(sessionId) || this.deps.turns.getRunningTurn(sessionId)) return;
    if (!this.deps.sessions.sessionExists(sessionId)) return;
    this.draining.add(sessionId);
    const turnId = randomUUID();
    try {
      // 先领取再启动, 使同步抛错也能通过 release 把整批内容原样归还.
      const claim = this.claim(sessionId, turnId, false);
      if (!claim) return;
      const session = this.deps.sessions.getSession(sessionId);
      const selection = this.selections.get(sessionId);
      // 有用户输入时保持 userMessage 语义; 新 Turn 每次只领取一个 Queue item,
      // 其余输入继续按 guided 优先、普通 after_turn 随后的顺序等待后续安全点或 Turn.
      // 纯后台通知使用 sessionContinuation,
      // 避免标题生成等只属于用户主动发言的业务被自动续接误触发.
      const handle = this.deps.startTurn({
        turnId,
        sessionId,
        triggerType: claim.type === 'user_input' ? 'userMessage' : 'sessionContinuation',
        sessionMode: selection?.sessionMode ?? session.sessionMode,
        narrativePolicy: selection?.narrativePolicy ?? session.narrativePolicy,
        input: claim.type === 'user_input' ? claim.userInput.input : [],
        ...(claim.type === 'completion_notices'
          ? { completionNoticeText: claim.completionNoticeText }
          : {}),
        ...(selection?.knowledge ? { knowledge: selection.knowledge } : {}),
      });
      // 排队项不保留旧 TTS 选择; 到真正启动 Turn 时才读取 Session 当前偏好.
      this.deps.attachTurn(handle, session.ttsEnabled);
    } catch (error) {
      this.release(turnId);
      console.warn('[continuation] Session 续接启动失败:', error);
    } finally {
      this.draining.delete(sessionId);
    }
  }

  /**
   * nextIterationOnly 为 true 时, 用户输入只能领取 delivery='next_iteration' 的立即引导项.
   * 为 false 时, 先领取最早的立即引导项, 没有时再领取最早的 after_turn 项.
   * 后台完成通知使用下方的独立顺序, 不受该参数过滤.
   */
  private claim(
    sessionId: string,
    turnId: string,
    nextIterationOnly: boolean,
  ): ClaimedSessionContinuation | undefined {
    if (this.claims.has(turnId)) return undefined;
    const availableInputs = (this.inputs.get(sessionId) ?? [])
      .filter(item => item.claimedByTurnId === undefined);
    const guidedInputs = availableInputs.filter(item => item.delivery === 'next_iteration');
    const afterTurnInputs = availableInputs.filter(item => item.delivery === 'after_turn');
    // 每次只领取一条用户输入. AgentLoop 在同一安全点逐条确认 guided；新 Turn 仍然
    // guided 优先，否则领取最早的普通排队项.
    const userInput = nextIterationOnly
      ? guidedInputs[0]
      : guidedInputs[0] ?? afterTurnInputs[0];
    // 后台终态只在当前进程内投递一次. 断电后的完整结果仍可由模型按 id 主动读取,
    // 但应用启动不会因此擅自创建新 Turn 或调用模型.
    const notices = (this.completionNotices.get(sessionId) ?? [])
      .filter(notice => notice.claimedByTurnId === undefined);
    // 迭代安全点保持原有顺序：先交付后台终态，再交付用户引导。新 Turn 则由用户输入
    // 优先取得执行身份，后台通知在 Turn 启动后的首个安全点继续领取.
    if (notices.length > 0 && (nextIterationOnly || !userInput)) {
      for (const notice of notices) notice.claimedByTurnId = turnId;
      this.claims.set(turnId, {
        type: 'completion_notices',
        sessionId,
        completionNoticeKeys: notices.map(notice => notice.key),
      });
      return {
        type: 'completion_notices',
        turnId,
        completionNoticeText: formatCompletionNoticeText(notices),
      };
    }
    if (!userInput) return undefined;

    userInput.claimedByTurnId = turnId;
    this.claims.set(turnId, {
      type: 'user_input',
      sessionId,
      userInputId: userInput.id,
    });
    return {
      type: 'user_input',
      turnId,
      userInput: publicItem(userInput),
    };
  }
}

/** 去掉内部领取标记, 避免把宿主事务状态泄露到 WebSocket 或 Turn 输入. */
function publicItem(item: PendingInput): QueuedSessionInput {
  const { claimedByTurnId: _claimedByTurnId, ...visible } = item;
  return visible;
}

/** 把多条后台终态整理成一条内部 continuation Message, 模型再按 ID 主动读取完整结果. */
function formatCompletionNoticeText(notices: readonly CompletionNotice[]): string {
  if (notices.length === 0) return '';
  const lines = notices.map(notice => notice.kind === 'subagent'
    ? `Subagent ${notice.id} 已结束, status=${notice.status}. 如需完整结果, 调用 SubagentAwait.`
    : `BackgroundProcess ${notice.id} 已结束, status=${notice.status}. 如需完整输出, 调用 ProcessOutput.`);
  return `以下后台工作已结束. 这里只通知身份与终态, 不代表结果已读:\n${lines.join('\n')}`;
}

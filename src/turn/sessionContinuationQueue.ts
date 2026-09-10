// 按 Session 串联用户排队输入和本进程后台终态, 并只在 Agent 的安全边界交付给模型.

import { randomUUID } from 'node:crypto';
import type { AgentRunStatus } from '@ema-agent/agent';
import type { SessionStore } from '@ema-agent/session';
import type { BackgroundProcessNotifiableStatus } from '@ema-agent/tools';
import type {
  StartTurn,
  TurnHandle,
  TurnInputPart,
  TurnKnowledgeSelection,
  TurnModelSelection,
} from './types.js';
import type { TurnStore } from './turnStore.js';

/**
 * Session 后续自动启动的 Turn 沿用最近一次入队时的输入区选择.
 * 选择跟 Session 保存, 而不是跟单条队列项保存. 多条输入合并为一根 Turn 时以最新选择为准;
 * 只有后台通知、没有排队输入时, 也能继续使用该 Session 最近一次明确选择.
 */
export interface SessionTurnSelection {
  readonly executionProfile: StartTurn['executionProfile'];
  readonly narrativePolicy: StartTurn['narrativePolicy'];
  readonly modelSelection?: TurnModelSelection;
  readonly knowledge?: TurnKnowledgeSelection;
  readonly ttsEnabled: boolean;
}

/** WebSocket enqueue_input 交给队列的完整业务输入. 内容此时只进入进程内存, 尚未写入 Message. */
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
 * Session WebSocket 的队列同步协议. queued_inputs 用于连接后的当前列表,
 * added/updated/removed 是后续增量; consumed 只在对应 Message 已成功落库后发送.
 */
export type SessionContinuationEvent =
  | { readonly type: 'queued_inputs'; readonly items: readonly QueuedSessionInput[] }
  | { readonly type: 'queued_input_added'; readonly item: QueuedSessionInput }
  | { readonly type: 'queued_input_updated'; readonly item: QueuedSessionInput }
  | { readonly type: 'queued_input_removed'; readonly id: string }
  | { readonly type: 'queued_inputs_consumed'; readonly ids: readonly string[]; readonly turnId: string };

/**
 * Turn 从队列临时领取的内容. 领取不等于消费: 调用方写完 Message 后必须 acknowledge,
 * 准备或写库失败则必须 release, 这样输入和后台通知才不会静默丢失.
 */
export interface ClaimedSessionContinuation {
  readonly turnId: string;
  readonly userInputs: readonly QueuedSessionInput[];
  readonly completionNoticeText?: string;
}

/** 队列内部条目. claimedByTurnId 存在时禁止删除、改为引导或被另一根 Turn 重复领取. */
interface PendingInput extends Omit<QueuedSessionInput, 'delivery'> {
  delivery: QueuedSessionInput['delivery'];
  claimedByTurnId?: string;
}

/**
 * 后台完成通知只携带执行身份和终态, 不复制完整输出.
 * key 统一两类执行的去重身份; 完整结果分别留在 AgentRun SQL 和后台进程日志中.
 */
type CompletionNotice =
  | {
      readonly key: string;
      readonly kind: 'agent_run';
      readonly id: string;
      readonly status: Exclude<AgentRunStatus, 'running'>;
      claimedByTurnId?: string;
    }
  | {
      readonly key: string;
      readonly kind: 'background_process';
      readonly id: string;
      readonly status: BackgroundProcessNotifiableStatus;
      claimedByTurnId?: string;
    };

/** 一次领取的反向索引. acknowledge 和 release 通过它成批处理该 Turn 已占用的内容. */
interface ContinuationClaim {
  readonly sessionId: string;
  readonly userInputIds: readonly string[];
  readonly completionNoticeKeys: readonly string[];
}

/**
 * 队列依赖由 Server Composition 装配. Session/Turn Store 提供权威存在性和忙碌状态;
 * startTurn 与 attachTurn 负责真正启动执行并接入事件消费; publish 只同步前端队列状态.
 */
export interface SessionContinuationQueueDeps {
  readonly sessions: Pick<SessionStore, 'getSession' | 'sessionExists'>;
  readonly turns: Pick<TurnStore, 'getActiveTurn'>;
  readonly startTurn: (input: StartTurn) => TurnHandle;
  readonly attachTurn: (handle: TurnHandle, ttsEnabled: boolean) => void;
  readonly publish: (sessionId: string, event: SessionContinuationEvent) => void;
}

/**
 * 队列只保存当前进程还没交付的输入和轻量完成通知. AgentRun 与后台命令的完整结果
 * 由各自的 SQL/日志保存, 模型需要详情时按通知中的 id 调 SubagentAwait 或 ProcessOutput.
 */
export class SessionContinuationQueue {
  /** 每个 Session 尚未确认消费的用户输入, 保留入队顺序. */
  private readonly inputs = new Map<string, PendingInput[]>();
  /** 每个 Session 最近一次输入区选择, 供后续自动 Turn 使用. */
  private readonly selections = new Map<string, SessionTurnSelection>();
  /** 当前进程产生但尚未交付模型的后台终态通知. */
  private readonly completionNotices = new Map<string, CompletionNotice[]>();
  /** 已被 Turn 暂时占用的输入和通知, 是 acknowledge/release 的依据. */
  private readonly claims = new Map<string, ContinuationClaim>();
  /** 防止同一 Session 被多个排水微任务重复启动 Turn. */
  private readonly draining = new Set<string>();
  private stopped = false;

  constructor(private readonly deps: SessionContinuationQueueDeps) {}

  /**
   * 入队时冻结输入与选择, 避免前端草稿或调用方对象随后变化影响已经排队的内容.
   * 若 Session 当前空闲, requestDrain 会在同一调用栈结束后把同期输入自然合批为一根 Turn.
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
    const index = items?.findIndex(item => item.id === id && item.claimedByTurnId === undefined) ?? -1;
    if (!items || index < 0) return false;
    items.splice(index, 1);
    if (items.length === 0) this.inputs.delete(sessionId);
    this.deps.publish(sessionId, { type: 'queued_input_removed', id });
    return true;
  }

  /** 把尚未领取的普通排队输入改为下一次安全迭代边界交付, 不直接打断正在生成的 LLM. */
  guide(sessionId: string, id: string): boolean {
    const item = this.inputs.get(sessionId)?.find(candidate => (
      candidate.id === id && candidate.claimedByTurnId === undefined
    ));
    if (!item) return false;
    item.delivery = 'next_iteration';
    this.deps.publish(sessionId, { type: 'queued_input_updated', item: publicItem(item) });
    return true;
  }

  /**
   * AgentLoop 只在 Assistant 和整批 ToolResult 都已关账后调用这里. 普通排队输入
   * 留给下一根 Turn, 只有立即引导和此刻已完成的后台通知可进入当前循环.
   */
  claimNextIteration(sessionId: string, turnId: string): ClaimedSessionContinuation | undefined {
    return this.claim(sessionId, turnId, true);
  }

  /** Message 已落库后才确认领取, 防止投影或写库失败时静默吞掉队列项. */
  acknowledge(turnId: string): void {
    const claim = this.claims.get(turnId);
    if (!claim) return;
    const inputIds = new Set(claim.userInputIds);
    const remainingInputs = (this.inputs.get(claim.sessionId) ?? [])
      .filter(item => !inputIds.has(item.id));
    if (remainingInputs.length > 0) this.inputs.set(claim.sessionId, remainingInputs);
    else this.inputs.delete(claim.sessionId);

    const noticeKeys = new Set(claim.completionNoticeKeys);
    const remainingNotices = (this.completionNotices.get(claim.sessionId) ?? [])
      .filter(notice => !noticeKeys.has(notice.key));
    if (remainingNotices.length > 0) this.completionNotices.set(claim.sessionId, remainingNotices);
    else this.completionNotices.delete(claim.sessionId);

    this.claims.delete(turnId);
    if (claim.userInputIds.length > 0) {
      this.deps.publish(claim.sessionId, {
        type: 'queued_inputs_consumed', ids: claim.userInputIds, turnId,
      });
    }
  }

  /** Turn 准备、附件处理或 Message 写库失败时撤销领取, 原内容继续留在队列等待下次交付. */
  release(turnId: string): void {
    const claim = this.claims.get(turnId);
    if (!claim) return;
    const inputIds = new Set(claim.userInputIds);
    for (const item of this.inputs.get(claim.sessionId) ?? []) {
      if (inputIds.has(item.id) && item.claimedByTurnId === turnId) item.claimedByTurnId = undefined;
    }
    const noticeKeys = new Set(claim.completionNoticeKeys);
    for (const notice of this.completionNotices.get(claim.sessionId) ?? []) {
      if (noticeKeys.has(notice.key) && notice.claimedByTurnId === turnId) notice.claimedByTurnId = undefined;
    }
    this.claims.delete(turnId);
  }

  /** AgentRunExecutor 已先持久化终态, 此处只把轻量通知加入所属 Session. */
  agentRunCompleted(
    sessionId: string,
    agentRunId: string,
    status: Exclude<AgentRunStatus, 'running'>,
  ): void {
    this.addCompletionNotice(sessionId, {
      key: `agent_run:${agentRunId}`,
      kind: 'agent_run',
      id: agentRunId,
      status,
    });
  }

  /** SubagentAwait 已取得完整终态时, 撤掉尚未注入模型的同一条轻量通知. */
  agentRunResultRead(sessionId: string, agentRunId: string): void {
    const notices = this.completionNotices.get(sessionId);
    if (!notices) return;
    const key = `agent_run:${agentRunId}`;
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
    if (this.stopped || this.draining.has(sessionId) || this.deps.turns.getActiveTurn(sessionId)) return;
    // 同一调用栈里可能连续加入多条输入或多个后台通知. 推到微任务后统一领取,
    // 既能自然合批, 也避免 startTurn 在生产者的终态回调栈内重入.
    queueMicrotask(() => this.drain(sessionId));
  }

  private drain(sessionId: string): void {
    if (this.stopped || this.draining.has(sessionId) || this.deps.turns.getActiveTurn(sessionId)) return;
    if (!this.deps.sessions.sessionExists(sessionId)) return;
    this.draining.add(sessionId);
    const turnId = randomUUID();
    try {
      // 先领取再启动, 使同步抛错也能通过 release 把整批内容原样归还.
      const claim = this.claim(sessionId, turnId, false);
      if (!claim) return;
      const session = this.deps.sessions.getSession(sessionId);
      const selection = this.selections.get(sessionId);
      // 有用户输入时保持 userMessage 语义; 纯后台通知使用 sessionContinuation,
      // 避免标题生成等只属于用户主动发言的业务被自动续接误触发.
      const handle = this.deps.startTurn({
        turnId,
        sessionId,
        triggerType: claim.userInputs.length > 0 ? 'userMessage' : 'sessionContinuation',
        executionProfile: selection?.executionProfile ?? session.executionProfile,
        narrativePolicy: selection?.narrativePolicy ?? session.narrativePolicy,
        input: mergeQueuedUserInput(claim.userInputs),
        ...(claim.completionNoticeText
          ? { completionNoticeText: claim.completionNoticeText }
          : {}),
        ...(selection?.modelSelection ? { modelSelection: selection.modelSelection } : {}),
        ...(selection?.knowledge ? { knowledge: selection.knowledge } : {}),
      });
      this.deps.attachTurn(handle, selection?.ttsEnabled ?? false);
    } catch (error) {
      this.release(turnId);
      console.warn('[continuation] Session 续接启动失败:', error);
    } finally {
      this.draining.delete(sessionId);
    }
  }

  private claim(
    sessionId: string,
    turnId: string,
    nextIterationOnly: boolean,
  ): ClaimedSessionContinuation | undefined {
    if (this.claims.has(turnId)) return undefined;
    // 当前 AgentLoop 只取显式引导项; 新 Turn 排水则按顺序领取全部未占用输入.
    const userInputs = (this.inputs.get(sessionId) ?? []).filter(item => (
      item.claimedByTurnId === undefined
      && (!nextIterationOnly || item.delivery === 'next_iteration')
    ));
    // 后台终态只在当前进程内投递一次. 断电后的完整结果仍可由模型按 id 主动读取,
    // 但应用启动不会因此擅自创建新 Turn 或调用模型.
    const notices = (this.completionNotices.get(sessionId) ?? [])
      .filter(notice => notice.claimedByTurnId === undefined);
    if (userInputs.length === 0 && notices.length === 0) return undefined;

    // 标记和反向索引必须在内容离开本方法前同时建立. 后续只有 acknowledge 或 release
    // 能结束这次领取, 其他入口都会把这些项目视为不可操作.
    for (const item of userInputs) item.claimedByTurnId = turnId;
    for (const notice of notices) notice.claimedByTurnId = turnId;
    this.claims.set(turnId, {
      sessionId,
      userInputIds: userInputs.map(item => item.id),
      completionNoticeKeys: notices.map(notice => notice.key),
    });
    const completionNoticeText = formatCompletionNoticeText(notices);
    return {
      turnId,
      userInputs: userInputs.map(publicItem),
      ...(completionNoticeText ? { completionNoticeText } : {}),
    };
  }
}

/** 去掉内部领取标记, 避免把宿主事务状态泄露到 WebSocket 或 Turn 输入. */
function publicItem(item: PendingInput): QueuedSessionInput {
  const { claimedByTurnId: _claimedByTurnId, ...visible } = item;
  return visible;
}

/** 同期排队输入保持原顺序合并, 两条输入之间补空行, 不改动每条输入内部的多模态顺序. */
function mergeQueuedUserInput(userInputs: readonly QueuedSessionInput[]): readonly TurnInputPart[] {
  const parts: TurnInputPart[] = [];
  for (const item of userInputs) {
    if (parts.length > 0) parts.push({ type: 'text', text: '\n\n' });
    parts.push(...item.input);
  }
  return parts;
}

/** 把多条后台终态整理成一条内部 continuation Message, 模型再按 ID 主动读取完整结果. */
function formatCompletionNoticeText(notices: readonly CompletionNotice[]): string {
  if (notices.length === 0) return '';
  const lines = notices.map(notice => notice.kind === 'agent_run'
    ? `AgentRun ${notice.id} 已结束, status=${notice.status}. 如需完整结果, 调用 SubagentAwait.`
    : `BackgroundProcess ${notice.id} 已结束, status=${notice.status}. 如需完整输出, 调用 ProcessOutput.`);
  return `以下后台工作已结束. 这里只通知身份与终态, 不代表结果已读:\n${lines.join('\n')}`;
}

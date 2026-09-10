// 进程级持有子 Agent 的执行、结果归属与取消关系，使后台运行不再依附父 Turn。

import type { SubagentRunResult, SubagentSpawnOptions } from '@ema-agent/tools';
import { runAgentLoop } from './agentLoop.js';
import type { AgentLoopEvent, AgentRunEvent } from './events.js';
import type { AgentRunMessagesStore } from './runs/agentRunMessagesStore.js';
import type { AgentRunStore } from './runs/agentRunStore.js';
import type { AgentLoopInput } from './types.js';

export interface PrepareSubagentInput {
  readonly agentRunId: string;
  readonly prompt: string;
  readonly options: SubagentSpawnOptions;
  readonly signal: AbortSignal;
}

export type PrepareSubagent = (input: PrepareSubagentInput) => Promise<AgentLoopInput>;

export interface StartAgentRun {
  readonly sessionId: string;
  readonly parentTurnId: string;
  readonly parentAgentRunId?: string;
  readonly prompt: string;
  readonly options: SubagentSpawnOptions & { readonly agentRunId: string };
  readonly prepareSubagent: PrepareSubagent;
  readonly parentSignal: AbortSignal;
  readonly runInBackground: boolean;
  readonly onLlmCallFinished?: (event: Extract<AgentLoopEvent, { type: 'llm_call_finished' }>) => void;
}

/** 
 * 一份 AgentRun 结果同一时刻只能有一个等待方, 避免 ToolResult 与 Session 通知重复交付.
 * - subagent_call: 初次调用子代理后, 在同步等待期内完成未转入后台. 结果直接作为原 Subagent 工具的 ToolResult 返回, 取消信号跟随父 Turn.
 * - subagent_await: 子代理已经转入后台, 后来模型主动调用 SubagentAwait(agentRunId) 等待并取得结果. 
 *    结果作为这次 SubagentAwait 的ToolResult 返回. 不要求仍在原 Turn, 也不再跟随原父 Turn 的取消信号.
 * - session_notification: 子代理转入后台后, 没有等待方占有结果. 
 *    完成时只向所属 Session 的继续队列投递一条轻量通知, 提示模型通过 ID 查询完整结果 不跟随父 Turn 的取消信号.
 */
type ResultOwner = 'subagent_call' | 'subagent_await' | 'session_notification';

interface ActiveAgentRun {
  readonly sessionId: string;
  readonly parentTurnId: string;
  readonly controller: AbortController;
  readonly completion: Promise<SubagentRunResult>;
  owner: ResultOwner;
  detachParentAbort?: () => void;
}

export interface AgentRunExecutorDeps {
  readonly store: AgentRunStore;
  readonly messages: AgentRunMessagesStore;
  readonly maxConcurrent: () => number;
  readonly publish: (sessionId: string, event: AgentRunEvent) => void;
  readonly onBackgroundCompleted: (
    sessionId: string,
    agentRunId: string,
    status: 'completed' | 'failed' | 'cancelled',
  ) => void;
  readonly onTerminalResultRead: (sessionId: string, agentRunId: string) => void;
}

export class AgentRunExecutor {
  private readonly active = new Map<string, ActiveAgentRun>();
  private stoppingReason: string | undefined;

  constructor(private readonly deps: AgentRunExecutorDeps) {}

  start(input: StartAgentRun): string {
    const agentRunId = input.options.agentRunId;
    if (this.stoppingReason) throw new Error(this.stoppingReason);
    if (this.active.has(agentRunId) || this.deps.store.get(agentRunId)) {
      throw new Error(`AgentRun ${agentRunId} 已存在`);
    }
    if (this.active.size >= this.deps.maxConcurrent()) {
      throw new Error('子 Agent 已达到全进程并发上限');
    }

    const controller = new AbortController();
    // 显式后台从出生起就属于 Session, 因此不能接父 Turn 的取消信号.
    // 默认路径先跟随父 Turn, 只有超过前台等待期限才解除这条关系.
    const completion = this.execute(input, controller);
    const active: ActiveAgentRun = {
      sessionId: input.sessionId,
      parentTurnId: input.parentTurnId,
      controller,
      owner: input.runInBackground ? 'session_notification' : 'subagent_call',
      completion,
    };
    if (!input.runInBackground) {
      const abortFromParent = (): void => controller.abort(input.parentSignal.reason);
      if (input.parentSignal.aborted) abortFromParent();
      else input.parentSignal.addEventListener('abort', abortFromParent, { once: true });
      active.detachParentAbort = () => input.parentSignal.removeEventListener('abort', abortFromParent);
    }
    this.active.set(agentRunId, active);
    void completion.finally(() => {
      active.detachParentAbort?.();
      this.active.delete(agentRunId);
      // execute 先把终态事实写入 SQL, completion 才会兑现. 只有结果仍归 Session 时发送轻量通知;
      // 原 Tool 或 SubagentAwait 会通过自己的 ToolResult 交付结果.
      if (active.owner === 'session_notification') {
        const terminal = this.deps.store.get(agentRunId);
        if (terminal && terminal.status !== 'running') {
          this.deps.onBackgroundCompleted(active.sessionId, agentRunId, terminal.status);
        }
      }
    }).catch(() => undefined);
    return agentRunId;
  }

  async waitForInitialResult(agentRunId: string, sessionId: string, signal: AbortSignal): Promise<SubagentRunResult | null> {
    const active = this.ownedActive(agentRunId, sessionId);
    if (!active || active.owner !== 'subagent_call') return null;
    return waitWithoutCancelling(active.completion, signal);
  }

  moveToBackground(agentRunId: string, sessionId: string): void {
    const active = this.ownedActive(agentRunId, sessionId);
    if (!active || active.owner !== 'subagent_call') {
      throw new Error(`AgentRun ${agentRunId} 当前不能转入后台`);
    }
    active.owner = 'session_notification';
    // 转后台只改变等待者和取消关系. AgentLoop 与 completion 都是原对象,
    // 这里绝不能重新启动任务或复制一条执行链.
    active.detachParentAbort?.();
    active.detachParentAbort = undefined;
  }

  /**
   * 单等待者是一次 SubagentAwait Tool 调用。sessionId 只校验 AgentRun 归属当前 Session，
   * signal 也只取消这次 Tool 等待. 后台执行仍由 AgentRunExecutor 持有.
   */
  async awaitResult(agentRunId: string, sessionId: string, signal: AbortSignal): Promise<SubagentRunResult | null> {
    const active = this.ownedActive(agentRunId, sessionId);
    if (active) {
      if (active.owner !== 'session_notification') return null;
      active.owner = 'subagent_await';
      try {
        return await waitWithoutCancelling(active.completion, signal);
      } finally {
        // 用户停止的是这次等待, 不是后台 AgentRun. 
        // 若执行仍活着, 把结果归还 Session 续接, 让它在后续安全点正常交付.
        if (this.active.get(agentRunId) === active && active.owner === 'subagent_await') {
          active.owner = 'session_notification';
        }
      }
    }

    const stored = this.deps.store.get(agentRunId);
    if (!stored || stored.sessionId !== sessionId || stored.status === 'running') return null;
    // 终态结果按 id 可重复读取. 断电后不自动创建 Turn, 由模型根据历史中的 id 主动查询.
    this.deps.onTerminalResultRead(sessionId, agentRunId);
    if (stored.status !== 'completed') {
      throw new Error(stored.error ?? `AgentRun ${agentRunId} ended with status ${stored.status}`);
    }
    return {
      agentRunId,
      output: stored.finalText ?? '',
      usage: {
        inputTokens: stored.inputTokens ?? 0,
        outputTokens: stored.outputTokens ?? 0,
      },
    };
  }

  cancel(agentRunId: string, sessionId?: string): boolean {
    const active = this.active.get(agentRunId);
    if (!active || (sessionId !== undefined && active.sessionId !== sessionId)) return false;
    active.controller.abort(new Error('Sub-agent aborted by user'));
    return true;
  }

  async abortForegroundForTurn(turnId: string): Promise<void> {
    const completions: Promise<SubagentRunResult>[] = [];
    for (const active of this.active.values()) {
      // 已经转后台的运行不再属于父 Turn 的收尾范围.
      if (active.parentTurnId === turnId && active.owner === 'subagent_call') {
        active.controller.abort(new Error('Parent Turn ended'));
        completions.push(active.completion);
      }
    }
    await Promise.allSettled(completions);
  }

  async abortForSession(sessionId: string): Promise<void> {
    const completions: Promise<SubagentRunResult>[] = [];
    for (const active of this.active.values()) {
      if (active.sessionId !== sessionId) continue;
      active.controller.abort(new Error('Session deleted'));
      completions.push(active.completion);
    }
    await Promise.allSettled(completions);
  }

  async abortForTurn(turnId: string): Promise<void> {
    const completions: Promise<SubagentRunResult>[] = [];
    for (const active of this.active.values()) {
      if (active.parentTurnId !== turnId) continue;
      active.controller.abort(new Error('Parent Turn removed'));
      completions.push(active.completion);
    }
    await Promise.allSettled(completions);
  }

  async waitForTurnAgentRuns(turnId: string): Promise<void> {
    const completions = [...this.active.values()]
      .filter(active => active.parentTurnId === turnId)
      .map(active => active.completion);
    await Promise.allSettled(completions);
  }

  async shutdown(reason: string): Promise<void> {
    this.stoppingReason = reason;
    const completions = [...this.active.values()].map(active => {
      active.controller.abort(new Error(reason));
      return active.completion;
    });
    await Promise.allSettled(completions);
  }

  private ownedActive(agentRunId: string, sessionId: string): ActiveAgentRun | undefined {
    const active = this.active.get(agentRunId);
    return active?.sessionId === sessionId ? active : undefined;
  }

  private async execute(input: StartAgentRun, controller: AbortController): Promise<SubagentRunResult> {
    const { agentRunId } = input.options;
    const startedAt = Date.now();
    const contextMode = input.options.contextMode ?? 'subagent';
    const providerId = input.options.providerId;
    const modelId = input.options.modelId;
    let toolCallCount = 0;
    this.deps.store.start({
      agentRunId,
      sessionId: input.sessionId,
      parentTurnId: input.parentTurnId,
      ...(input.parentAgentRunId ? { parentAgentRunId: input.parentAgentRunId } : {}),
      contextMode,
      ...(input.options.description ? { description: input.options.description } : {}),
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
    });
    this.deps.publish(input.sessionId, {
      type: 'agent_run_started', agentRunId, contextMode, startedAt,
      ...(modelId ? { modelId } : {}),
      ...(input.options.description ? { description: input.options.description } : {}),
    });

    try {
      const loopInput = await input.prepareSubagent({
        agentRunId, prompt: input.prompt, options: input.options, signal: controller.signal,
      });
      let terminal: Extract<AgentLoopEvent, { type: 'loop_stopped' }> | undefined;
      for await (const event of runAgentLoop(loopInput)) {
        if (event.type === 'tool_use_completed') toolCallCount += 1;
        // 持久 transcript 必须先越过对应语义边界, 然后才能恢复 generator
        // 触发下一步工具副作用. 实时发布独立于 SQL, 不借父 Turn 通道.
        this.deps.messages.record(agentRunId, event);
        this.deps.publish(input.sessionId, { type: 'agent_run_event', agentRunId, event });
        if (event.type === 'llm_call_finished') input.onLlmCallFinished?.(event);
        if (event.type === 'loop_stopped') terminal = event;
      }
      if (controller.signal.aborted) throw abortReason(controller.signal, 'Sub-agent aborted');
      if (!terminal) throw new Error('AgentLoop 未产生终止事件');
      // 终态与 finalText 先写入事实表. 后续通知即使无人在线也不会丢结果.
      const result = this.deps.store.complete(agentRunId, {
        iterations: terminal.state.iterations,
        toolCallCount,
        inputTokens: terminal.state.usage.inputTokens,
        outputTokens: terminal.state.usage.outputTokens,
        finalText: terminal.finalText,
      });
      assertTransitionCompleted(agentRunId, result, 'complete');
      this.deps.publish(input.sessionId, { type: 'agent_run_completed', agentRunId, finalText: terminal.finalText });
      return {
        agentRunId,
        output: terminal.finalText,
        usage: { inputTokens: terminal.state.usage.inputTokens, outputTokens: terminal.state.usage.outputTokens },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        const reason = this.stoppingReason ?? message;
        assertTransitionCompleted(agentRunId, this.deps.store.cancel(agentRunId, reason), 'cancel');
        this.deps.publish(input.sessionId, { type: 'agent_run_aborted', agentRunId, reason });
      } else {
        assertTransitionCompleted(agentRunId, this.deps.store.fail(agentRunId, message), 'fail');
        this.deps.publish(input.sessionId, { type: 'agent_run_failed', agentRunId, error: message });
      }
      throw error;
    }
  }
}

async function waitWithoutCancelling<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return null;
  return new Promise<T | null>((resolve, reject) => {
    // 调用方取消只结束 await. 是否取消底层执行由结果所有者在外层决定.
    const onAbort = (): void => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function assertTransitionCompleted(
  agentRunId: string,
  result: ReturnType<AgentRunStore['complete']>,
  action: 'complete' | 'fail' | 'cancel',
): void {
  if (result.ok) return;
  throw new Error(`AgentRun ${agentRunId} 无法写入 ${action} 终态：${result.reason}`);
}

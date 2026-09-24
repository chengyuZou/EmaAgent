// 进程级持有子 Agent 的执行、结果归属与取消关系，使后台运行不再依附父 Turn。

import type { SubagentResult, SubagentSpawnOptions } from '@ema-agent/tools';
import { runAgentLoop } from './agentLoop.js';
import type { AgentLoopEvent, SubagentEvent } from './events.js';
import type { SubagentMessagesStore } from './subagents/subagentMessagesStore.js';
import type { SubagentStore } from './subagents/subagentStore.js';
import type { AgentLoopInput } from './types.js';

export interface PrepareSubagentInput {
  readonly subagentId: string;
  readonly prompt: string;
  readonly options: SubagentSpawnOptions;
  readonly signal: AbortSignal;
}

export type PrepareSubagent = (input: PrepareSubagentInput) => Promise<AgentLoopInput>;

export interface StartSubagent {
  readonly sessionId: string;
  readonly parentTurnId: string;
  readonly prompt: string;
  readonly options: SubagentSpawnOptions & { readonly subagentId: string };
  readonly prepareSubagent: PrepareSubagent;
  readonly parentSignal: AbortSignal;
  readonly runInBackground: boolean;
  readonly onLlmCallFinished?: (event: Extract<AgentLoopEvent, { type: 'llm_call_finished' }>) => void;
}

/** 
 * 一份 Subagent 结果同一时刻只能有一个等待方, 避免 ToolResult 与 Session 通知重复交付.
 * - subagent_call: 初次调用子代理后, 在同步等待期内完成未转入后台. 结果直接作为原 Subagent 工具的 ToolResult 返回, 取消信号跟随父 Turn.
 * - subagent_await: 子代理已经转入后台, 后来模型主动调用 SubagentAwait(subagentId) 等待并取得结果. 
 *    结果作为这次 SubagentAwait 的ToolResult 返回. 不要求仍在原 Turn, 也不再跟随原父 Turn 的取消信号.
 * - session_notification: 子代理转入后台后, 没有等待方占有结果. 
 *    完成时只向所属 Session 的继续队列投递一条轻量通知, 提示模型通过 ID 查询完整结果 不跟随父 Turn 的取消信号.
 */
type ResultOwner = 'subagent_call' | 'subagent_await' | 'session_notification';

interface ActiveSubagent {
  readonly sessionId: string;
  readonly parentTurnId: string;
  readonly controller: AbortController;
  readonly completion: Promise<SubagentResult>;
  owner: ResultOwner;
  detachParentAbort?: () => void;
}

export interface SubagentExecutorDeps {
  readonly store: SubagentStore;
  readonly messages: SubagentMessagesStore;
  readonly maxConcurrent: () => number;
  readonly publish: (sessionId: string, event: SubagentEvent) => void;
  readonly onBackgroundCompleted: (
    sessionId: string,
    subagentId: string,
    status: 'completed' | 'failed' | 'cancelled',
  ) => void;
  readonly onTerminalResultRead: (sessionId: string, subagentId: string) => void;
}

export class SubagentExecutor {
  private readonly active = new Map<string, ActiveSubagent>();
  private stoppingReason: string | undefined;

  constructor(private readonly deps: SubagentExecutorDeps) {}

  start(input: StartSubagent): string {
    const subagentId = input.options.subagentId;
    if (this.stoppingReason) throw new Error(this.stoppingReason);
    if (this.active.has(subagentId) || this.deps.store.get(subagentId)) {
      throw new Error(`Subagent ${subagentId} 已存在`);
    }
    if (this.active.size >= this.deps.maxConcurrent()) {
      throw new Error('子 Agent 已达到全进程并发上限');
    }

    const controller = new AbortController();
    // 显式后台从出生起就属于 Session, 因此不能接父 Turn 的取消信号.
    // 默认路径先跟随父 Turn, 只有超过前台等待期限才解除这条关系.
    const completion = this.execute(input, controller);
    const active: ActiveSubagent = {
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
    this.active.set(subagentId, active);
    void completion.finally(() => {
      active.detachParentAbort?.();
      this.active.delete(subagentId);
      // execute 先把终态事实写入 SQL, completion 才会兑现. 只有结果仍归 Session 时发送轻量通知;
      // 原 Tool 或 SubagentAwait 会通过自己的 ToolResult 交付结果.
      if (active.owner === 'session_notification') {
        const terminal = this.deps.store.get(subagentId);
        if (terminal && terminal.status !== 'running') {
          this.deps.onBackgroundCompleted(active.sessionId, subagentId, terminal.status);
        }
      }
    }).catch(() => undefined);
    return subagentId;
  }

  async waitForInitialResult(subagentId: string, sessionId: string, signal: AbortSignal): Promise<SubagentResult | null> {
    const active = this.ownedActive(subagentId, sessionId);
    if (!active || active.owner !== 'subagent_call') return null;
    return waitWithoutCancelling(active.completion, signal);
  }

  moveToBackground(subagentId: string, sessionId: string): void {
    const active = this.ownedActive(subagentId, sessionId);
    if (!active || active.owner !== 'subagent_call') {
      throw new Error(`Subagent ${subagentId} 当前不能转入后台`);
    }
    active.owner = 'session_notification';
    // 转后台只改变等待者和取消关系. AgentLoop 与 completion 都是原对象,
    // 这里绝不能重新启动任务或复制一条执行链.
    active.detachParentAbort?.();
    active.detachParentAbort = undefined;
  }

  /**
   * 单等待者是一次 SubagentAwait Tool 调用。sessionId 只校验 Subagent 归属当前 Session，
   * signal 也只取消这次 Tool 等待. 后台执行仍由 SubagentExecutor 持有.
   */
  async awaitResult(subagentId: string, sessionId: string, signal: AbortSignal): Promise<SubagentResult | null> {
    const active = this.ownedActive(subagentId, sessionId);
    if (active) {
      if (active.owner !== 'session_notification') return null;
      active.owner = 'subagent_await';
      try {
        return await waitWithoutCancelling(active.completion, signal);
      } finally {
        // 用户停止的是这次等待, 不是后台 Subagent. 
        // 若执行仍活着, 把结果归还 Session 续接, 让它在后续安全点正常交付.
        if (this.active.get(subagentId) === active && active.owner === 'subagent_await') {
          active.owner = 'session_notification';
        }
      }
    }

    const stored = this.deps.store.get(subagentId);
    if (!stored || stored.sessionId !== sessionId || stored.status === 'running') return null;
    // 终态结果按 id 可重复读取. 断电后不自动创建 Turn, 由模型根据历史中的 id 主动查询.
    this.deps.onTerminalResultRead(sessionId, subagentId);
    if (stored.status !== 'completed') {
      throw new Error(stored.error ?? `Subagent ${subagentId} ended with status ${stored.status}`);
    }
    return {
      subagentId,
      output: stored.finalText ?? '',
      usage: {
        inputTokens: stored.inputTokens ?? 0,
        outputTokens: stored.outputTokens ?? 0,
      },
    };
  }

  cancel(subagentId: string, sessionId?: string): boolean {
    const active = this.active.get(subagentId);
    if (!active || (sessionId !== undefined && active.sessionId !== sessionId)) return false;
    active.controller.abort(new Error('Sub-agent aborted by user'));
    return true;
  }

  async abortForegroundForTurn(turnId: string): Promise<void> {
    const completions: Promise<SubagentResult>[] = [];
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
    const completions: Promise<SubagentResult>[] = [];
    for (const active of this.active.values()) {
      if (active.sessionId !== sessionId) continue;
      active.controller.abort(new Error('Session deleted'));
      completions.push(active.completion);
    }
    await Promise.allSettled(completions);
  }

  async abortForTurn(turnId: string): Promise<void> {
    const completions: Promise<SubagentResult>[] = [];
    for (const active of this.active.values()) {
      if (active.parentTurnId !== turnId) continue;
      active.controller.abort(new Error('Parent Turn removed'));
      completions.push(active.completion);
    }
    await Promise.allSettled(completions);
  }

  async waitForTurnSubagents(turnId: string): Promise<void> {
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

  private ownedActive(subagentId: string, sessionId: string): ActiveSubagent | undefined {
    const active = this.active.get(subagentId);
    return active?.sessionId === sessionId ? active : undefined;
  }

  private async execute(input: StartSubagent, controller: AbortController): Promise<SubagentResult> {
    const { subagentId } = input.options;
    const startedAt = Date.now();
    const contextMode = input.options.contextMode ?? 'subagent';
    const providerId = input.options.providerId;
    const modelId = input.options.modelId;
    let toolCallCount = 0;
    this.deps.store.start({
      subagentId,
      sessionId: input.sessionId,
      parentTurnId: input.parentTurnId,
      contextMode,
      ...(input.options.description ? { description: input.options.description } : {}),
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
    });
    this.deps.publish(input.sessionId, {
      type: 'subagent_started', subagentId, contextMode, startedAt,
      ...(modelId ? { modelId } : {}),
      ...(input.options.description ? { description: input.options.description } : {}),
    });

    let terminal: Extract<AgentLoopEvent, { type: 'loop_stopped' }> | undefined;
    try {
      const loopInput = await input.prepareSubagent({
        subagentId, prompt: input.prompt, options: input.options, signal: controller.signal,
      });
      for await (const event of runAgentLoop(loopInput)) {
        if (event.type === 'tool_use_completed') toolCallCount += 1;
        // 持久 transcript 必须先越过对应语义边界, 然后才能恢复 generator
        // 触发下一步工具副作用. 实时发布独立于 SQL, 不借父 Turn 通道.
        this.deps.messages.record(subagentId, event);
        publishLoopEvent(this.deps.publish, input.sessionId, subagentId, event);
        if (event.type === 'llm_call_finished') input.onLlmCallFinished?.(event);
        if (event.type === 'loop_stopped') terminal = event;
      }
      if (controller.signal.aborted) throw abortReason(controller.signal, 'Sub-agent aborted');
      if (!terminal) throw new Error('AgentLoop 未产生终止事件');
    } catch (error) {
      this.deps.messages.interruptActiveAssistant(subagentId);
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        const reason = this.stoppingReason ?? message;
        this.deps.store.cancel(subagentId, reason);
        this.deps.publish(input.sessionId, { type: 'subagent_aborted', subagentId, reason });
      } else {
        this.deps.store.fail(subagentId, message);
        this.deps.publish(input.sessionId, { type: 'subagent_failed', subagentId, error: message });
      }
      throw error;
    }

    // 终态与 finalText 先写入事实表, 再发完成事件. 写库错误不能被当成 AgentLoop 失败重写为 failed.
    this.deps.store.complete(subagentId, {
      iterations: terminal.state.iterations,
      toolCallCount,
      inputTokens: terminal.state.usage.inputTokens,
      outputTokens: terminal.state.usage.outputTokens,
      finalText: terminal.finalText,
    });
    this.deps.publish(input.sessionId, { type: 'subagent_completed', subagentId });
    return {
      subagentId,
      output: terminal.finalText,
      usage: { inputTokens: terminal.state.usage.inputTokens, outputTokens: terminal.state.usage.outputTokens },
    };
  }
}

function publishLoopEvent(
  publish: SubagentExecutorDeps['publish'],
  sessionId: string,
  subagentId: string,
  event: AgentLoopEvent,
): void {
  switch (event.type) {
    case 'iteration_started':
      publish(sessionId, {
        type: 'iteration_started',
        subagentId,
        iteration: event.iteration,
        continuesOutput: event.continuesOutput,
      });
      return;
    case 'text_delta':
      publish(sessionId, {
        type: 'text_delta',
        subagentId,
        blockIndex: event.blockIndex,
        delta: event.delta,
      });
      return;
    case 'thinking_delta':
      publish(sessionId, {
        type: 'thinking_delta',
        subagentId,
        blockIndex: event.blockIndex,
        delta: event.delta,
      });
      return;
    case 'tool_use_completed':
      publish(sessionId, {
        type: 'tool_use_completed',
        subagentId,
        blockIndex: event.blockIndex,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      return;
    case 'tool_result':
      publish(sessionId, {
        type: 'tool_result',
        subagentId,
        result: event.result,
      });
      return;
    default:
      return;
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

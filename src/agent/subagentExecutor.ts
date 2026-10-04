// 进程级持有子 Agent 的执行、结果归属与取消关系，使后台运行不再依附父 Turn。

import { randomUUID } from 'node:crypto';
import type { ReasoningEffort } from '@ema-agent/session';
import type { PermissionModeRow } from '@ema-agent/storage';
import { ToolExecutionError, type SubagentResult, type SubagentSpawnOptions, type ToolExecutionEvent } from '@ema-agent/tools';
import { runAgentLoop } from './agentLoop.js';
import type { AgentLoopEvent, SubagentEvent } from './events.js';
import type { SubagentMessagesStore } from './subagents/subagentMessagesStore.js';
import type { SubagentStore } from './subagents/subagentStore.js';
import type { AgentLoopInput } from './types.js';

export interface PrepareSubagentInput {
  readonly subagentId: string;
  readonly runId: string;
  readonly isNew: boolean;
  readonly messageStore: SubagentMessagesStore;
  /** 与工作历史同序, 摘要保存和循环追加共用这一数组. */
  readonly messageIds: (string | undefined)[];
  readonly prompt: string;
  readonly options: SubagentSpawnOptions;
  readonly signal: AbortSignal;
}

export type PrepareSubagent = (input: PrepareSubagentInput) => Promise<AgentLoopInput>;

export interface StartSubagent {
  readonly sessionId: string;
  readonly parentTurnId: string;
  readonly toolCallId: string;
  readonly prompt: string;
  readonly options: SubagentSpawnOptions;
  readonly permissionMode: PermissionModeRow;
  readonly reasoningEffort: ReasoningEffort;
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
  readonly runId: string;
  readonly sessionId: string;
  readonly parentTurnId: string;
  readonly controller: AbortController;
  readonly completion: Promise<SubagentResult>;
  owner: ResultOwner;
  detachParentAbort?: () => void;
}

export interface SubagentExecutorDeps {
  readonly store: SubagentStore;
  readonly messageStore: SubagentMessagesStore;
  readonly maxConcurrent: () => number;
  readonly publish: (sessionId: string, event: SubagentEvent) => void;
  readonly onBackgroundCompleted: (
    sessionId: string,
    subagentId: string,
    status: 'completed' | 'failed' | 'cancelled',
  ) => void;
  readonly onTerminalResultRead: (sessionId: string, subagentId: string) => void;
  /**
   * 本次 Run 完成、失败或取消后的针对该RunId的permission收尾通知.
   * 宿主用 runId 清理这次执行尚未解决的批准请求.
   * 不按父 Turn 清理, 不影响同一子代理后续的 Run; 执行异常退出也会通知.
   */
  readonly onRunFinished: (runId: string) => void;
}

export class SubagentExecutor {
  private readonly active = new Map<string, ActiveSubagent>();
  private stoppingReason: string | undefined;

  constructor(private readonly deps: SubagentExecutorDeps) { }

  /** 工具执行器的进度属于这个 Run, 不能借已经结束的父 Turn 输出. */
  publishToolProgress(
    sessionId: string,
    subagentId: string,
    runId: string,
    event: Extract<ToolExecutionEvent, { type: 'tool_progress' }>
  ): void {
    this.deps.publish(
      sessionId,
      {
        type: 'tool_progress',
        subagentId,
        runId,
        toolCallId: event.callId,
        progress: event.progress
      }
    );
  }

  start(input: StartSubagent): { readonly subagentId: string; readonly runId: string } {
    const isNew = input.options.subagentId === undefined;
    const subagentId = input.options.subagentId ?? randomUUID();
    const previous = isNew ? undefined : this.deps.store.get(subagentId);
    if (!isNew && (!previous || previous.sessionId !== input.sessionId)) {
      throw new Error(`当前 Session 中不存在 Subagent ${subagentId}`);
    }
    if (this.stoppingReason) {
      throw new Error(this.stoppingReason);
    }
    if (this.active.size >= this.deps.maxConcurrent()) {
      throw new Error('子 Agent 已达到全进程并发上限');
    }

    const options: SubagentSpawnOptions = {
      ...input.options,
      providerId: input.options.providerId ?? previous?.providerId ?? undefined,
      modelId: input.options.modelId ?? previous?.modelId ?? undefined,
      description: input.options.description ?? previous?.description ?? undefined,
      contextMode: input.options.contextMode ?? this.deps.store.latestRun(subagentId)?.contextMode ?? 'subagent',
    };
    const runId = randomUUID();
    this.deps.store.start({
      subagentId,
      runId,
      isNew,
      toolCallId: input.toolCallId,
      sessionId: input.sessionId,
      contextMode: options.contextMode!,
      title: input.options.title,
      description: options.description,
    });

    const controller = new AbortController();
    // 显式后台从出生起就属于 Session, 因此不能接父 Turn 的取消信号.
    // 默认路径先跟随父 Turn, 只有超过前台等待期限才解除这条关系.
    if (!input.runInBackground && input.parentSignal.aborted) {
      controller.abort(input.parentSignal.reason);
    }
    const completion = this.execute(
      { ...input, options },
      subagentId,
      runId,
      isNew,
      controller
    );
    const active: ActiveSubagent = {
      runId,
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
      this.deps.onRunFinished(runId);
      active.detachParentAbort?.();
      if (this.active.get(subagentId) === active) {
        this.active.delete(subagentId);
      }
      // execute 先把终态事实写入 SQL, completion 才会兑现. 只有结果仍归 Session 时发送轻量通知;
      // 原 Tool 或 SubagentAwait 会通过自己的 ToolResult 交付结果.
      if (active.owner === 'session_notification') {
        const terminal = this.deps.store.getRun(runId);
        if (terminal && terminal.status !== 'running') {
          this.deps.onBackgroundCompleted(active.sessionId, subagentId, terminal.status);
        }
      }
    }).catch(() => undefined);
    return { subagentId, runId };
  }

  async waitForInitialResult(subagentId: string, sessionId: string, signal: AbortSignal): Promise<SubagentResult | null> {
    const active = this.ownedActive(subagentId, sessionId);
    if (!active || active.owner !== 'subagent_call') {
      return null;
    }
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
      if (active.owner !== 'session_notification') {
        return null;
      }
      active.owner = 'subagent_await';
      try {
        return await waitWithoutCancelling(active.completion, signal);
      } catch (error) {
        const run = this.deps.store.getRun(active.runId);
        throw new ToolExecutionError(
          { subagentId, runId: active.runId },
          error instanceof Error ? error.message : String(error),
          run?.status === 'cancelled' ? 'tool/cancelled' : 'tool/error'
        );
      } finally {
        // 用户停止的是这次等待, 不是后台 Subagent. 
        // 若执行仍活着, 把结果归还 Session 续接, 让它在后续安全点正常交付.
        if (this.active.get(subagentId) === active && active.owner === 'subagent_await') {
          active.owner = 'session_notification';
        }
      }
    }

    const identity = this.deps.store.get(subagentId);
    if (!identity || identity.sessionId !== sessionId) {
      return null;
    }
    const stored = this.deps.store.latestRun(subagentId);
    if (!stored || stored.status === 'running') {
      return null;
    }
    // 终态结果按 id 可重复读取. 断电后不自动创建 Turn, 由模型根据历史中的 id 主动查询.
    this.deps.onTerminalResultRead(sessionId, subagentId);
    if (stored.status !== 'completed') {
      throw new ToolExecutionError(
        { subagentId, runId: stored.id },
        stored.error ?? `Subagent ${subagentId} ended with status ${stored.status}`,
        stored.status === 'cancelled' ? 'tool/cancelled' : 'tool/error'
      );
    }
    return {
      subagentId,
      runId: stored.id,
      output: stored.finalText ?? '',
      usage: { inputTokens: stored.inputTokens ?? 0, outputTokens: stored.outputTokens ?? 0 },
    };
  }

  cancel(subagentId: string, sessionId?: string): boolean {
    const active = this.active.get(subagentId);
    if (!active || (sessionId !== undefined && active.sessionId !== sessionId)) {
      return false;
    }
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
      if (active.sessionId !== sessionId) {
        continue;
      }
      active.controller.abort(new Error('Session deleted'));
      completions.push(active.completion);
    }
    await Promise.allSettled(completions);
  }

  async abortForTurn(turnId: string): Promise<void> {
    const completions: Promise<SubagentResult>[] = [];
    for (const active of this.active.values()) {
      if (active.parentTurnId !== turnId) {
        continue;
      }
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

  private async execute(
    input: StartSubagent,
    subagentId: string,
    runId: string,
    isNew: boolean,
    controller: AbortController,
  ): Promise<SubagentResult> {
    const startedAt = Date.now();
    let toolCallCount = 0;
    const toolNames = new Map<string, string>();
    this.deps.publish(
      input.sessionId,
      {
        type: 'subagent_started',
        subagentId,
        runId,
        startedAt,
        parentToolCallId: input.toolCallId,
      }
    );

    let terminal: Extract<AgentLoopEvent, { type: 'loop_stopped' }> | undefined;
    try {
      // 与模型工作历史逐条对齐, 保存每条消息的 SQL ID. 纯文本循环引导未入库, 对应 undefined.
      // Macro 摘要靠它找到覆盖截止 ID; 初始历史由 prepareSubagent 填入, 之后随循环追加或压缩改写.
      const messageIds: (string | undefined)[] = [];
      // Assistant/ToolResult 先落库, 后追加到模型历史. 暂存已写好的 ID,
      // 等 model_history_appended 时按追加顺序移入 messageIds, 不参与任务或通知调度.
      const pendingMessageIds: (string | undefined)[] = [];
      const loopInput = await input.prepareSubagent({
        subagentId,
        runId,
        isNew,
        messageStore: this.deps.messageStore,
        messageIds,
        prompt: input.prompt,
        options: input.options,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      this.deps.store.setConfiguration(
        runId,
        {
          ...loopInput.generationSource,
          permissionMode: input.permissionMode,
          reasoningEffort: input.reasoningEffort,
        }
      );
      // prepare 已保存本次任务. 即使面板在准备完成前打开, 也能补上这条真实 User Message.
      const task = this.deps.messageStore.listPage(subagentId, undefined, 1).items[0];
      if (task) {
        this.publishMessage(
          input.sessionId,
          subagentId,
          runId,
          task.id
        );
      }
      for await (const event of runAgentLoop(loopInput)) {
        if (event.type === 'tool_use_completed') {
          toolCallCount += 1;
          toolNames.set(event.toolCallId, event.toolName);
        }
        // 持久 transcript 必须先越过对应语义边界, 然后才能恢复 generator
        // 触发下一步工具副作用. 实时发布独立于 SQL, 不借父 Turn 通道.
        const messageId = this.deps.messageStore.record(subagentId, runId, event);
        if (event.type === 'assistant_message_completed' || event.type === 'tool_result') {
          pendingMessageIds.push(messageId);
        }
        if (event.type === 'model_history_appended') {
          for (const _message of event.messages) {
            messageIds.push(pendingMessageIds.shift());
          }
        }
        if (messageId) {
          this.publishMessage(
            input.sessionId,
            subagentId,
            runId,
            messageId,
            event.type === 'text_delta' || event.type === 'thinking_delta'
            || event.type === 'thinking_completed'
            || event.type === 'tool_use_completed'
          );
        }
        if (event.type === 'tool_result') {
          this.deps.publish(
            input.sessionId,
            {
              type: 'tool_result',
              subagentId,
              runId,
              toolName: toolNames.get(event.result.toolCallId)!,
              result: event.result
            }
          );
          toolNames.delete(event.result.toolCallId);
        }
        if (event.type === 'iteration_started') {
          this.deps.publish(
            input.sessionId,
            {
              type: 'iteration_started',
              subagentId,
              runId,
              iteration: event.iteration,
              continuesOutput: event.continuesOutput,
              run: this.deps.store.getRun(runId)!
            }
          );
        }
        if (event.type === 'llm_call_finished') {
          input.onLlmCallFinished?.(event);
        }
        if (event.type === 'loop_stopped') {
          terminal = event;
        }
      }
      if (controller.signal.aborted) {
        throw abortReason(controller.signal, 'Sub-agent aborted');
      }
      if (!terminal) {
        throw new Error('AgentLoop 未产生终止事件');
      }
    } catch (error) {
      const interruptedId = this.deps.messageStore.interruptActiveAssistant(runId);
      if (interruptedId) {
        this.publishMessage(
          input.sessionId,
          subagentId,
          runId,
          interruptedId
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        const reason = this.stoppingReason ?? message;
        this.deps.store.cancel(runId, reason);
        this.deps.publish(
          input.sessionId,
          {
            type: 'subagent_aborted',
            subagentId,
            runId,
            run: this.deps.store.getRun(runId)!
          }
        );
      } else {
        this.deps.store.fail(runId, message);
        this.deps.publish(
          input.sessionId,
          {
            type: 'subagent_failed',
            subagentId,
            runId,
            run: this.deps.store.getRun(runId)!
          }
        );
      }
      throw error;
    }

    // 终态与 finalText 先写入事实表, 再发完成事件. 写库错误不能被当成 AgentLoop 失败重写为 failed.
    this.deps.store.complete(
      runId,
      {
        iterations: terminal.state.iterations,
        toolCallCount,
        inputTokens: terminal.state.usage.inputTokens,
        outputTokens: terminal.state.usage.outputTokens,
        finalText: terminal.finalText,
      }
    );
    this.deps.publish(
      input.sessionId,
      {
        type: 'subagent_completed',
        subagentId,
        runId,
        run: this.deps.store.getRun(runId)!
      }
    );
    return {
      subagentId,
      runId,
      output: terminal.finalText,
      usage: { inputTokens: terminal.state.usage.inputTokens, outputTokens: terminal.state.usage.outputTokens },
    };
  }

  private publishMessage(
    sessionId: string,
    subagentId: string,
    runId: string,
    messageId: string,
    streaming = false
  ): void {
    const message = this.deps.messageStore.get(messageId)!;
    this.deps.publish(sessionId, { type: 'message_updated', subagentId, runId, message, streaming });
  }
}

async function waitWithoutCancelling<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) {
    return null;
  }
  return new Promise<T | null>((resolve, reject) => {
    // 调用方取消只结束 await. 是否取消底层执行由结果所有者在外层决定.
    const onAbort = (): void => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(value => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
  });
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

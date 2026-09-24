// 调度流式到达的工具调用，维护并发屏障、取消、进度事件和 FIFO 终态。

import type { ToolExecutionEvent } from '../events.js';
import type { ToolResultStore } from '../results/toolResultStore.js';
import {
  ToolCallExecution,
  type ToolExecutionEnvironment,
} from './toolCallExecution.js';
import type { ToolResult } from '../results/toolResult.js';

interface TrackedTool {
  readonly blockIndex: number;
  readonly execution: ToolCallExecution;
  done: boolean;
  terminalEmitted: boolean;
  resultDelivered: boolean;
  suppressEvents: boolean;
  result?: ToolResult;
  terminalEvent?: ToolExecutionEvent;
  promise?: Promise<void>;
}

export type StreamingToolExecutorEvent = ToolExecutionEvent;

export interface StreamingToolExecutorOptions extends ToolExecutionEnvironment {
  /** 写入 Agent 待发送事件队列；实现方同时负责唤醒流式排空循环。 */
  readonly pushEv: (event: StreamingToolExecutorEvent) => void;
  /** 工具完成但没有新增进度事件时，唤醒 Agent 重新检查 allDone()。 */
  readonly wake: () => void;
}

/**
 * 流式工具调度器。
 *
 * 单次调用的准备、权限、校验、审计和执行全部委托给 ToolExecution；本类只处理
 * 流式入队、并发安全工具与独占工具的屏障、取消、等待状态和模型顺序终态。
 */
export class StreamingToolExecutor {
  private tracked: TrackedTool[] = [];
  private readonly pendingTools = new Set<Promise<void>>();
  private exclusiveBarrier: Promise<void> = Promise.resolve();
  private stoppingReason?: string;

  constructor(private readonly options: StreamingToolExecutorOptions) {}

  abortTool(callId: string): boolean {
    const track = this.tracked.find(candidate => candidate.execution.id === callId && !candidate.done);
    if (!track) return false;
    track.execution.abort('user_abort');
    return true;
  }

  abortAll(reason: string): void {
    this.stoppingReason = reason;
    for (const track of this.tracked) {
      if (!track.done) track.execution.abort(reason);
    }
  }

  /** 等待当前已登记的工具全部退出。 */
  async join(): Promise<void> {
    await Promise.allSettled(
      this.tracked
        .map(track => track.promise)
        .filter((promise): promise is Promise<void> => promise !== undefined),
    );
  }

  /** Turn 进入终态前统一取消并等待；超时调用由单调用状态机保守关账。 */
  async shutdown(reason: string, timeoutMs = 5_000): Promise<void> {
    this.abortAll(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const joined = this.join().then(() => true);
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const completed = await Promise.race([joined, timedOut]);
    if (timer) clearTimeout(timer);
    if (completed) return;

    for (const track of this.tracked) {
      if (track.done) continue;
      track.suppressEvents = true;
      track.execution.closeAfterShutdown();
    }
  }

  /** 在两次 LLM 迭代之间清空已经结束的调度状态 */
  reset(): void {
    this.tracked = [];
    this.pendingTools.clear();
    this.exclusiveBarrier = Promise.resolve();
    this.stoppingReason = undefined;
  }

  /** 调用方已保存 tool_use 后登记; 立即进入并发/独占调度. */
  addTool(blockIndex: number, id: string, name: string, args: unknown): void {
    if (this.stoppingReason) return;

    let track!: TrackedTool;
    const execution = new ToolCallExecution(
      this.options,
      { callId: id, name, args },
      (event: ToolExecutionEvent) => {
        if (!track.suppressEvents) this.options.pushEv(event);
      },
    );
    track = {
      blockIndex,
      execution,
      done: false,
      terminalEmitted: false,
      resultDelivered: false,
      suppressEvents: false,
    };
    this.tracked.push(track);
    this.schedule(track);
  }

  /**
   * Tool分为并发安全和独占两类:
   * - 并发安全工具可以和其他并发安全工具同时执行，但必须等待前一个独占工具完成.
   * - 独占工具必须等待此前所有已调度工具完成，且后续工具不能越过它.
   */
  private schedule(track: TrackedTool): void {
    if (track.promise) {
      throw new Error(`tool_already_scheduled: ${track.execution.id}`);
    }

    let promise: Promise<void>;

    if (track.execution.isConcurrencySafe) {
      // 并发安全调用只需等待前一个独占调用 然后可以和其他 safe tool 并行
      promise = this.exclusiveBarrier.then(() => this.execute(track));
    } else {
      // 独占调用必须等待此前所有已调度调用完成
      const fence = Promise.allSettled(this.pendingTools);

      promise = fence.then(() => this.execute(track));

      // 后续调用不能越过本次独占调用 从现在开始后面的 safe tool 都必须等它
      this.exclusiveBarrier = promise;
    }

    track.promise = promise;
    this.pendingTools.add(promise);

    void promise.then(
      () => this.pendingTools.delete(promise),
    );
  }

  allDone(): boolean {
    return this.tracked.every(track => track.done);
  }

  hasWaitingUserTool(): boolean {
    return this.tracked.some(track => (
      track.execution.requiresUserInteraction && !track.done
    ));
  }

  /** 只交付从队首开始连续完成的结果；调用方持久化后必须 acknowledgeResult。 */
  takeCompletedResults(): ToolResult[] {
    const delivered: ToolResult[] = [];
    const ordered = [...this.tracked].sort((left, right) => left.blockIndex - right.blockIndex);
    for (const track of ordered) {
      if (track.resultDelivered) continue;
      if (!track.done || !track.result) break;
      track.resultDelivered = true;
      delivered.push(track.result);
    }
    return delivered;
  }

  /** Message 已持久化后再关执行状态，崩溃时才能保守恢复。 */
  acknowledgeResult(callId: string): void {
    const track = this.tracked.find(candidate => candidate.execution.id === callId);
    if (!track?.resultDelivered) {
      throw new Error(`tool_result_not_delivered: ${callId}`);
    }
    track.execution.commitResult();
  }

  private async execute(track: TrackedTool): Promise<void> {
    try {
      if (this.stoppingReason) track.execution.abort(this.stoppingReason);
      const completion = await track.execution.run();
      track.result = completion.result;
      track.terminalEvent = completion.terminalEvent;
    } catch (error) {
      // ToolExecution 自己会把业务、权限、审计和工具错误转成终态；这里只防止
      // 调度 Promise 因真正的内部缺陷拒绝后阻断 serialTail。
      const message = error instanceof Error ? error.message : String(error);
      track.result = {
        type: 'tool_result',
        toolCallId: track.execution.id,
        content: message,
        isError: true,
        errorCode: 'tool/runtime_error',
      };
      track.terminalEvent = {
        type: 'tool_result',
        sessionId: this.options.sessionId,
        callId: track.execution.id,
        name: track.execution.name,
        error: { code: 'tool/runtime_error', message },
        durationMs: 0,
      };
    } finally {
      track.done = true;
      this.flushTerminalEvents();
      this.options.wake();
    }
  }

  /**
   * 后完成的调用不能越过前面的模型 block 发射终态。
   * 审批和工具进度仍实时发送，只有 tool_result 在此保持 FIFO。
   */
  private flushTerminalEvents(): void {
    const ordered = [...this.tracked].sort((left, right) => left.blockIndex - right.blockIndex);
    for (const track of ordered) {
      if (track.terminalEmitted) continue;
      if (!track.done) break;
      track.terminalEmitted = true;
      if (!track.suppressEvents && track.terminalEvent) {
        this.options.pushEv(track.terminalEvent);
      }
    }
  }
}

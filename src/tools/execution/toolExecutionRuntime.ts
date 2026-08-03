// 调度流式到达的工具调用，维护并发屏障、取消、进度事件和 FIFO 终态。

import { asToolCallId } from '@ema-agent/ids';
import type { ToolExecutionEvent } from '../events.js';
import type { ToolResultStore } from '../results/toolResultStore.js';
import {
  ToolExecution,
  type ToolExecutionEnvironment,
  type ToolExecutionHostContext,
  type ToolExecutionLiveEvent,
} from './toolExecution.js';
import type { ToolExecutionResult } from './toolExecutionResult.js';

interface TrackedTool<THostContext extends ToolExecutionHostContext> {
  readonly blockIndex: number;
  readonly execution: ToolExecution<THostContext>;
  done: boolean;
  terminalEmitted: boolean;
  suppressEvents: boolean;
  result?: ToolExecutionResult;
  terminalEvent?: ToolExecutionEvent;
  promise?: Promise<void>;
}

export type ToolExecutionRuntimeEvent = ToolExecutionLiveEvent;

export interface ToolExecutionRuntimeOptions<THostContext extends ToolExecutionHostContext>
  extends ToolExecutionEnvironment<THostContext> {
  /** 写入 Agent 待发送事件队列；实现方同时负责唤醒流式排空循环。 */
  readonly pushEv: (event: ToolExecutionRuntimeEvent) => void;
  /** 工具完成但没有新增进度事件时，唤醒 Agent 重新检查 allDone()。 */
  readonly signal: () => void;
}

/**
 * 流式工具调度器。
 *
 * 单次调用的准备、权限、校验、审计和执行全部委托给 ToolExecution；本类只处理
 * 流式入队、并发安全工具与独占工具的屏障、取消、等待状态和模型顺序终态。
 */
export class ToolExecutionRuntime<THostContext extends ToolExecutionHostContext = ToolExecutionHostContext> {
  private tracked: Array<TrackedTool<THostContext>> = [];
  private serialTail: Promise<void> = Promise.resolve();
  private stoppingReason?: string;

  constructor(private readonly options: ToolExecutionRuntimeOptions<THostContext>) {}

  /** 取消指定工具，不中止父 Turn。 */
  abortTool(callId: string): boolean {
    const track = this.tracked.find(candidate => candidate.execution.id === callId && !candidate.done);
    if (!track) return false;
    track.execution.abort('user_abort');
    return true;
  }

  /** 停止接收新调用并取消本 Turn 尚未结束的工具。 */
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
      track.execution.closeAfterShutdown(reason);
    }
  }

  /** 在两次 LLM 迭代之间清空已经结束的调度状态。 */
  reset(): void {
    this.tracked = [];
    this.serialTail = Promise.resolve();
    this.stoppingReason = undefined;
  }

  /** 模型完成一个 tool_use block 时立即入队，不等待整段 assistant 流结束。 */
  addTool(blockIndex: number, id: string, name: string, args: unknown): void {
    if (this.stoppingReason) return;

    let track!: TrackedTool<THostContext>;
    const execution = new ToolExecution(
      this.options,
      { callId: asToolCallId(id), name, args },
      (event: ToolExecutionLiveEvent) => {
        if (!track.suppressEvents) this.options.pushEv(event);
      },
    );
    track = {
      blockIndex,
      execution,
      done: false,
      terminalEmitted: false,
      suppressEvents: false,
    };

    const priorPromises = this.tracked
      .map(candidate => candidate.promise)
      .filter((promise): promise is Promise<void> => promise !== undefined);
    this.tracked.push(track);

    if (execution.isConcurrencySafe) {
      track.promise = this.serialTail.then(() => this.execute(track));
      return;
    }

    const fence = Promise.allSettled([this.serialTail, ...priorPromises]);
    const promise = fence.then(() => this.execute(track));
    this.serialTail = promise;
    track.promise = promise;
  }

  allDone(): boolean {
    return this.tracked.every(track => track.done);
  }

  hasWaitingUserTool(): boolean {
    return this.tracked.some(track => (
      track.execution.requiresUserInteraction && !track.done
    ));
  }

  /** 按模型 block 顺序返回结果，应在 allDone() 后调用。 */
  getResults(): ToolExecutionResult[] {
    const sorted = [...this.tracked]
      .filter(track => track.result !== undefined)
      .sort((left, right) => left.blockIndex - right.blockIndex);
    const store = this.options.toolResultStore;
    if (!store) return sorted.map(track => track.result!);

    const contents = this.enforceAggregateBudget(sorted, store);
    return sorted.map((track) => {
      const result = track.result!;
      const content = contents.get(track.execution.id);
      return content === undefined || content === result.content
        ? result
        : { ...result, content };
    });
  }

  private async execute(track: TrackedTool<THostContext>): Promise<void> {
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
        toolUseId: track.execution.id,
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
      this.options.signal();
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

  private enforceAggregateBudget(
    tracks: ReadonlyArray<TrackedTool<THostContext>>,
    store: ToolResultStore,
  ): ReadonlyMap<string, string> {
    return store.enforceAggregateBudget(
      tracks.flatMap(track => {
        const result = track.result;
        const maxResultBytes = track.execution.maxResultBytes;
        if (!result || typeof result.content !== 'string' || maxResultBytes === undefined) return [];
        return [{
          callId: track.execution.id,
          toolName: track.execution.name,
          content: result.content,
          maxResultBytes,
        }];
      }),
    );
  }
}

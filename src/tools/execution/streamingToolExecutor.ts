import type { ToolExecutionEvent } from './toolEvents.js';
import type { ToolExecutionContext } from './toolExecutionContext.js';
import { ToolCallExecution } from './toolCallExecution.js';
import type { ToolCallOutcome } from './toolCallOutcome.js';
import type { ToolResult } from '../results/toolResult.js';

interface ScheduledToolCall {
  readonly blockIndex: number;
  readonly execution: ToolCallExecution;
  // 等本调用完成排队, 权限检查和实际执行, 或生成取消结果.
  // 完成后不代表结果 Message 已经保存, 也不代表被取消调用之前的工具都已结束.
  completionPromise?: Promise<void>;
  completion?: ToolCallOutcome;
  terminalEventPublished: boolean;
  resultDelivered: boolean;
  // 关闭等待超时后, 不再让迟到的进度或终态进入已经结束的 Turn.
  suppressEvents: boolean;
}

export type StreamingToolExecutorOptions = ToolExecutionContext & {
  readonly publishEvent: (event: ToolExecutionEvent) => void;
  // 没有进度事件的工具也会完成, 因此完成时必须唤醒 AgentLoop 检查结果.
  readonly wake: () => void;
};

export class StreamingToolExecutor {
  private readonly callsById = new Map<string, ScheduledToolCall>();
  // 与 Map 引用相同的记录, 只在登记新调用时按模型 blockIndex 排序.
  private readonly orderedCalls: ScheduledToolCall[] = [];
  // 每个 Promise 同时等两件事: 该工具原本要等的更早工具结束, 以及该工具自己处理结束.
  // 例如 A 运行中, B 排在 A 后面却被取消: B 可先返回取消结果, 此处仍要等 A.
  // 后面的工具因此不会利用 B 的取消越过仍在执行的 A. 这里只保存尚未满足这两个条件的调用.
  private readonly scheduledCallCompletionPromises = new Set<Promise<void>>();
  // 最近一个独占调用连同它等待的更早调用何时结束. 尚无独占调用时已完成, 不阻挡并发工具.
  private lastExclusiveCallFinished: Promise<void> = Promise.resolve();
  private stoppingReason?: string;

  constructor(private readonly options: StreamingToolExecutorOptions) {}

  abortTool(toolCallId: string): boolean {
    const call = this.callsById.get(toolCallId);
    if (!call || call.completion) return false;
    call.execution.abort('user_abort');
    return true;
  }

  abortAll(reason: string): void {
    this.stoppingReason = reason;
    for (const call of this.orderedCalls) {
      if (!call.completion) call.execution.abort(reason);
    }
  }

  /** 等当前已登记的工具处理完, 包括等待用户批准或继续操控; 不等待结果 Message 落库确认. */
  async join(): Promise<void> {
    await Promise.allSettled(this.orderedCalls.map(call => call.completionPromise));
  }

  async shutdown(reason: string, timeoutMs = 5_000): Promise<void> {
    this.abortAll(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    // 先发取消, 再等调用退出. 超时只结束本执行器的等待和事件发布, 不宣称底层操作已经撤销.
    const completed = await Promise.race([this.join().then(() => true), timedOut]);
    if (timer) clearTimeout(timer);
    if (completed) return;

    for (const call of this.orderedCalls) {
      if (call.completion) continue;
      call.suppressEvents = true;
      call.execution.closeAfterShutdown();
    }
  }

  /** Agent 保存 tool_use 后调用. 构造时解析参数并登记电脑调用, 然后按并发规则开始排队. */
  addTool(blockIndex: number, id: string, name: string, args: unknown): void {
    if (this.stoppingReason) return;
    let call!: ScheduledToolCall;
    const execution = new ToolCallExecution(this.options, { callId: id, name, args }, event => {
      if (!call.suppressEvents) this.options.publishEvent(event);
    });
    call = {
      blockIndex,
      execution,
      terminalEventPublished: false,
      resultDelivered: false,
      suppressEvents: false,
    };
    this.callsById.set(id, call);
    this.orderedCalls.push(call);
    this.orderedCalls.sort((left, right) => left.blockIndex - right.blockIndex);
    this.schedule(call);
  }

  private schedule(call: ScheduledToolCall): void {
    const earlierToolsFinished = call.execution.isConcurrencySafe
      ? this.lastExclusiveCallFinished
      : Promise.allSettled(this.scheduledCallCompletionPromises).then(() => undefined);

    // run 同时等执行顺序和本调用取消. 被取消的调用可先生成结果, 无需等更早的长工具结束.
    call.completionPromise = this.completeCall(call, earlierToolsFinished);
    const callAndEarlierToolsFinished = Promise.allSettled([
      earlierToolsFinished,
      call.completionPromise,
    ]).then(() => undefined);
    if (!call.execution.isConcurrencySafe) {
      this.lastExclusiveCallFinished = callAndEarlierToolsFinished;
    }
    this.scheduledCallCompletionPromises.add(callAndEarlierToolsFinished);
    void callAndEarlierToolsFinished.then(() => {
      this.scheduledCallCompletionPromises.delete(callAndEarlierToolsFinished);
    });
  }

  allDone(): boolean {
    return this.orderedCalls.every(call => call.completion !== undefined);
  }

  hasWaitingUserTool(): boolean {
    return this.orderedCalls.some(call => call.execution.requiresUserInteraction && !call.completion);
  }

  /** 结果可以先生成, 但只按模型顺序交付连续完成的前缀. */
  takeCompletedResults(): ToolResult[] {
    const results: ToolResult[] = [];
    for (const call of this.orderedCalls) {
      if (call.resultDelivered) continue;
      if (!call.completion) break;
      call.resultDelivered = true;
      results.push(call.completion.result);
    }
    return results;
  }

  /** 调用方保存 tool_result Message 后确认, 此时才将执行记录写成终态. */
  acknowledgeResult(toolCallId: string): void {
    const call = this.callsById.get(toolCallId);
    if (!call?.resultDelivered) throw new Error(`tool_result_not_delivered: ${toolCallId}`);
    call.execution.commitResult();
  }

  private async completeCall(call: ScheduledToolCall, earlierToolsFinished: Promise<void>): Promise<void> {
    try {
      call.completion = await call.execution.run(earlierToolsFinished);
    } catch (error) {
      // 业务失败在单次调用内转换. 此处接住登记清理或执行器异常, 让工具配对和后续调度仍能结束.
      const message = error instanceof Error ? error.message : String(error);
      call.completion = {
        status: 'failed',
        result: {
          type: 'tool_result', toolCallId: call.execution.id, content: message,
          isError: true, errorCode: 'tool/runtime_error',
        },
        terminalEvent: {
          type: 'tool_result', sessionId: this.options.sessionId,
          callId: call.execution.id, name: call.execution.name,
          error: { code: 'tool/runtime_error', message }, durationMs: 0,
        },
      };
    } finally {
      this.publishCompletedEvents();
      this.options.wake();
    }
  }

  private publishCompletedEvents(): void {
    for (const call of this.orderedCalls) {
      if (call.terminalEventPublished) continue;
      if (!call.completion) break;
      call.terminalEventPublished = true;
      if (!call.suppressEvents) this.options.publishEvent(call.completion.terminalEvent);
    }
  }
}

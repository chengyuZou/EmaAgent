import type { ToolResultContentPart } from '@ema-agent/llm';
import { checkToolPermission, type PermissionRequest } from '@ema-agent/permission';
import { ToolExecutionError } from '../errors.js';
import type { AnyTool } from '../definition/tool.js';
import type { ToolInvocation } from '../definition/toolInvocation.js';
import type { ToolResult } from '../results/toolResult.js';
import type { ToolError, ToolExecutionEvent } from './toolEvents.js';
import type { ToolExecutionStatus } from './toolExecutionState.js';
import type { ToolExecutionCall, ToolExecutionContext } from './toolExecutionContext.js';
import {
  classifyExecutionFailure, classifyCallPreparationError, errorMessage, executionStatusForOutcome,
  isCancelled, isExecutionNonTerminal, outcomeStatusForFailure, serializeToolOutput, toolUnavailable,
  type ToolCallOutcome,
} from './toolCallOutcome.js';

/**
 * 单次工具调用的执行状态机.
 *
 * StreamingToolExecutor 在登记时调用 run(), 并传入本调用需要等待的更早工具.
 * 构造时从 ToolPool 找到工具并只解析一次 Schema, 后续校验, Permission 和 execute 共用解析结果.
 */
export class ToolCallExecution {
  readonly id: string;
  readonly name: string;
  readonly isConcurrencySafe: boolean;
  readonly requiresUserInteraction: boolean;

  private readonly registeredAt = Date.now();
  private readonly abortController = new AbortController();
  private readonly tool?: AnyTool;
  private readonly input?: unknown;
  // 查找工具, 解析参数, 读取调度声明或登记电脑调用时发现的错误.
  // 构造阶段先记录, 后面的统一执行流程再生成失败 ToolResult.
  private readonly callPreparationError?: ToolError;
  private executionStatus?: ToolExecutionStatus;
  private outcome?: ToolCallOutcome;
  private executionPromise?: Promise<ToolCallOutcome>;
  private unregisterComputerToolCall?: () => void;

  constructor(
    private readonly executionContext: ToolExecutionContext,
    private readonly call: ToolExecutionCall,
    private readonly emit: (event: ToolExecutionEvent) => void,
  ) {
    this.id = call.callId;
    this.name = call.name;

    const tool = executionContext.toolPool.get(call.name);
    if (!tool) {
      this.callPreparationError = toolUnavailable(call.name);
      this.isConcurrencySafe = true;
      this.requiresUserInteraction = false;
      return;
    }

    try {
      const input = tool.inputSchema.parse(call.args);
      this.tool = tool;
      this.input = input;
      this.isConcurrencySafe = tool.isConcurrencySafe(input);
      this.requiresUserInteraction = tool.requiresUserInteraction(input);
      // 排队前就登记, ComputerUse 才能在操控结束时取消尚未轮到执行的电脑调用.
      this.unregisterComputerToolCall = executionContext.registerComputerToolCall?.(
        call,
        error => this.abort(error),
      );
    } catch (error) {
      this.callPreparationError = classifyCallPreparationError(call.name, error);
      this.isConcurrencySafe = true;
      this.requiresUserInteraction = false;
    }
  }

  /** 取消当前调用,不影响同 Turn 的其他工具. */
  abort(reason: string | ToolExecutionError = 'user_abort'): void {
    this.abortController.abort(reason);
  }

  get cancellationSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * StreamingToolExecutor 停止等待后关闭审计状态.
   * running 已越过副作用边界,只能标记 outcome_unknown;尚未运行则安全取消.
   */
  closeAfterShutdown(): void {
    if (this.executionStatus === 'running') {
      this.tryMarkOutcomeUnknown();
      return;
    }
    if (this.executionStatus === 'prepared' || this.executionStatus === 'authorized') {
      try {
        this.advanceExecutionState('cancel');
      } catch {
        // 启动恢复会清理尚未越过副作用边界的记录.
      }
    }
  }

  /** 同一个调用对象无论被等待几次,都只会越过一次副作用边界. */
  run(earlierToolsFinished: Promise<void> = Promise.resolve()): Promise<ToolCallOutcome> {
    this.executionPromise ??= this.runOnce(earlierToolsFinished);
    return this.executionPromise;
  }

  /** Tool Result 已写入 Message 后,才把薄执行状态推进到终态. */
  commitResult(): void {
    const outcome = this.outcome;
    if (!outcome) throw new Error(`tool_result_not_ready: ${this.id}`);
    if (!isExecutionNonTerminal(this.executionStatus)) return;

    const status = executionStatusForOutcome(
      outcome.status, this.executionStatus, this.abortController.signal.reason,
    );
    const state = this.executionContext.toolExecutionState;
    if (status === 'cancelled' && this.executionStatus === 'running') {
      // ComputerUse 已通过取消回调确认旧调用未提交动作, 即使已进入 execute 也按取消结果结束.
      const record = state?.completeFromMessage(this.id, { isError: true, errorCode: 'tool/cancelled' });
      if (record) this.executionStatus = record.status;
    } else {
      const transition = {
        succeeded: 'succeed',
        failed: 'fail',
        cancelled: 'cancel',
        outcome_unknown: 'outcomeUnknown',
      } as const;
      this.advanceExecutionState(transition[status]);
    }
  }

  private async runOnce(earlierToolsFinished: Promise<void>): Promise<ToolCallOutcome> {
    const parentSignal = this.executionContext.abortSignal;
    const onParentAbort = (): void => this.abort('turn_abort');
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    if (parentSignal.aborted) {
      this.abort('turn_abort');
    }

    try {
      await this.waitForEarlierToolsOrCancellation(earlierToolsFinished);
      await this.executePipeline();
    } catch (error) {
      if (isCancelled(this.abortController.signal, parentSignal)) {
        this.completeCancellation();
      } else if (!this.outcome) {
        this.completeFailure({ code: 'tool/internal_error', message: errorMessage(error) });
      }
    } finally {
      parentSignal.removeEventListener('abort', onParentAbort);
      this.unregisterComputerToolCall?.();
    }

    return this.outcome!;
  }

  /**
   * 校验和 Permission 前, 等待 StreamingToolExecutor 按本批并发规则选出的更早工具.
   * 并发安全工具等最近一个独占工具及其更早调用; 独占工具等全部更早登记的工具.
   * 更早工具成功, 失败或取消都算结束, 不要求它们成功.
   * 当前调用取消时提前返回, executePipeline 随即生成取消结果, 不执行具体工具.
   */
  private async waitForEarlierToolsOrCancellation(earlierToolsFinished: Promise<void>): Promise<void> {
    const signal = this.abortController.signal;
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish);
        resolve();
      };
      signal.addEventListener('abort', finish, { once: true });
      void earlierToolsFinished.then(finish, finish);
    });
  }

  private async executePipeline(): Promise<void> {
    const signal = this.abortController.signal;
    if (signal.aborted || this.executionContext.abortSignal.aborted) {
      this.completeCancellation();
      return;
    }
    if (this.callPreparationError) {
      this.completeFailure(this.callPreparationError);
      return;
    }

    // 构造阶段已完成工具查找, Schema 解析, 调度声明读取和电脑调用登记.
    const tool = this.tool!;
    const invocation = this.invocation(signal);
    signal.throwIfAborted();
    const contextProjection = tool.validateContext(this.executionContext.toolContext);
    if (!contextProjection.valid) {
      this.completeFailure({ code: 'tool/context_unavailable', message: contextProjection.reason });
      return;
    }

    if (!await this.validateInput(
      tool,
      this.input,
      contextProjection.context,
      invocation
    )) {
      return;
    }
    if (!this.prepareExecutionState(tool)) {
      return;
    }

    if (!await this.requestPermission(tool, this.input, contextProjection.context)) {
      return;
    }

    this.advanceExecutionState('authorize');
    await this.executeTool(
      tool,
      this.input,
      contextProjection.context,
      invocation
    );
  }

  private async validateInput(
    tool: AnyTool,
    input: unknown,
    narrowedContext: unknown,
    invocation: ToolInvocation,
  ): Promise<boolean> {
    try {
      // 文件检查或命令解析可能异步完成. ObserveWindow 也在这里预约操控, 随后才请求批准.
      // 校验未结束前不能进入 Permission; 校验失败则不调用 execute.
      const validation = await tool.validateInput?.(input, narrowedContext, invocation)
        ?? { valid: true as const };
      if (validation.valid) {
        return true;
      }
      this.completeFailure({ code: validation.code ?? 'tool/invalid_input', message: validation.message });
      return false;
    } catch (error) {
      this.completeFailure({ code: 'tool/validation_error', message: errorMessage(error) });
      return false;
    }
  }

  private prepareExecutionState(tool: AnyTool): boolean {
    try {
      const record = this.executionContext.toolExecutionState?.prepare({
        callId: this.id,
        sessionId: this.executionContext.sessionId,
        turnId: this.executionContext.turnId,
        subagentId: this.executionContext.subagentId,
        toolName: tool.name,
      });
      if (record) {
        this.executionStatus = record.status;
      }
      return true;
    } catch (error) {
      this.completeFailure({ code: 'tool/journal_prepare_failed', message: errorMessage(error) });
      return false;
    }
  }

  /**
   * Permission 返回 allow 时继续, deny 时生成失败结果, ask 时等用户回答.
   * Turn 提供的 askPermission 先保存 allowSession 对应的会话批准, 再返回回答.
   * 执行器不自行保存或推导批准范围.
   */
  private async requestPermission(tool: AnyTool, input: unknown, narrowedContext: unknown): Promise<boolean> {
    const {
      sessionId,
      turnId,
      permissionContext,
      askPermission
    } = this.executionContext;
    const signal = this.abortController.signal;

    try {
      // Permission 会调用工具的 checkPermissions 收集操作信息, 其中可能包含异步路径检查.
      const permissionCheckResult = await checkToolPermission(
        tool,
        input,
        narrowedContext,
        permissionContext,
        { interactive: askPermission !== undefined },
      );
      if (permissionCheckResult.decision === 'allow') {
        return true;
      }
      if (permissionCheckResult.decision === 'deny') {
        this.completeFailure({ code: 'permission/denied', message: permissionCheckResult.message });
        return false;
      }

      // ask:无交互通道时中央已返回 deny,能到这里 askPermission 必然存在.
      const summary = tool.getToolUseSummary?.(input);
      const requestFields = {
        toolName: tool.name,
        ...(summary ? { summary } : {}),
        message: permissionCheckResult.message,
        input,
        ...(permissionCheckResult.sessionApproval
          ? { sessionApprovalDescription: permissionCheckResult.sessionApproval.description }
          : {}),
        sessionId,
        turnId,
        toolCallId: this.id,
      };
      const request: PermissionRequest = this.executionContext.subagentId !== undefined
        ? { ...requestFields, subagentId: this.executionContext.subagentId, runId: this.executionContext.runId }
        : requestFields;
      // 等交互队列中的真实回答. 用户尚未决定时不能执行; signal 取消会撤销这条批准请求.
      const permissionUserResponse = await askPermission!(request, signal, permissionCheckResult.sessionApproval);

      if (isCancelled(signal, this.executionContext.abortSignal)) {
        this.completeCancellation();
        return false;
      }
      if (permissionUserResponse.action === 'allow' || permissionUserResponse.action === 'allowSession') {
        return true;
      }
      this.completeFailure({ code: 'permission/denied', message: permissionUserResponse.reason ?? '用户拒绝了本次调用' });
      return false;
    } catch (error) {
      if (isCancelled(signal, this.executionContext.abortSignal)) {
        this.completeCancellation();
      } else {
        this.completeFailure({ code: 'permission/error', message: errorMessage(error) });
      }
      return false;
    }
  }

  private async executeTool(
    tool: AnyTool,
    input: unknown,
    narrowedContext: unknown,
    invocation: ToolInvocation,
  ): Promise<void> {
    const { sessionId, turnId } = this.executionContext;
    const signal = this.abortController.signal;
    let output: unknown;

    try {
      // 用户回答 Permission 期间可能接管电脑. 真正执行前再等继续或结束, 已取消调用不重放.
      signal.throwIfAborted();
      // 先保存 running 再开始实际操作. 此后若中断且没有实际结果, 不能假定操作完全没发生.
      this.advanceExecutionState('start');
      // 等具体工具交回业务结果. 电脑动作若被中断, 由 Rust 的返回值说明是否可能部分完成.
      output = await tool.execute(
        input,
        narrowedContext,
        invocation,
        (progress: unknown) => this.emit({
          type: 'tool_progress',
          sessionId,
          turnId,
          callId: this.id,
          name: this.name,
          progress,
        }),
      );

      if (signal.aborted && !this.executionContext.abortSignal.aborted) {
        // 工具已经产出的结构化结果仍可展示和导航, 取消状态单独保存.
        this.completeCancellation(output);
        return;
      }

    } catch (error) {
      if (isCancelled(signal, this.executionContext.abortSignal)) {
        this.completeCancellation(error instanceof ToolExecutionError ? error.output : undefined);
        return;
      } else {
        this.completeFailure(
          classifyExecutionFailure(error),
          error instanceof ToolExecutionError ? error.output : undefined
        );
        return;
      }
    }

    const durationMs = this.durationMs();
    // 大文本可能要保存到结果文件. 完成后才把包含文件路径的 ToolResult 交给模型.
    const content = await this.normalizeResult(tool, output);
    this.outcome = {
      status: 'succeeded',
      result: {
        type: 'tool_result',
        toolCallId: this.id,
        content,
        data: output,
        isError: false,
        durationMs,
      },
      terminalEvent: {
        type: 'tool_result', sessionId, callId: this.id, name: this.name, output, durationMs,
      },
    };
  }

  private completeFailure(failure: ToolError, output?: unknown): void {
    this.outcome = {
      status: outcomeStatusForFailure(failure.code),
      result: {
        ...this.errorResult(failure.code, failure.message),
        ...(output !== undefined ? { data: output } : {}),
      },
      terminalEvent: {
        ...this.errorEvent(failure.code, failure.message),
        ...(output !== undefined ? { output } : {}),
      },
    };
  }

  private completeCancellation(data?: unknown): void {
    const reason = this.abortController.signal.reason;
    if (reason instanceof ToolExecutionError && !this.executionContext.abortSignal.aborted) {
      this.completeFailure(reason, data ?? reason.output);
      this.outcome = {
        ...this.outcome!,
        status: reason.code === 'tool/outcome_unknown' ? 'outcome_unknown' : 'cancelled',
      };
      return;
    }
    this.completeFailure({ code: 'tool/cancelled', message: '[用户中途终止]' }, data);
  }

  /**
   * 模型可见内容 = Tool 自定义投影,缺省按"string 原样,其余 JSON 化".
   * 文本走统一单项预算(超限外置);多模态 parts 不做文本外置,
   * 由 Tool 业务层自限尺寸(结果层没有语义能安全裁切它们).
   */
  private async normalizeResult(tool: AnyTool, output: unknown): Promise<string | ToolResultContentPart[]> {
    const modelContent = tool.mapResultToModelContent?.(output) ?? serializeToolOutput(output);
    if (typeof modelContent !== 'string') {
      return modelContent;
    }
    return this.executionContext.toolResultStore?.normalize(this.name, modelContent, tool.maxResultBytes) ?? modelContent;
  }

  private errorResult(code: string, message: string): ToolResult {
    return {
      type: 'tool_result',
      toolCallId: this.id,
      content: message,
      isError: true,
      durationMs: this.durationMs(),
      errorCode: code,
    };
  }

  private errorEvent(code: string, message: string): Extract<ToolExecutionEvent, { type: 'tool_result' }> {
    return {
      type: 'tool_result',
      sessionId: this.executionContext.sessionId,
      callId: this.id,
      name: this.name,
      error: { code, message },
      durationMs: this.durationMs(),
    };
  }

  private tryMarkOutcomeUnknown(): void {
    if (this.executionStatus !== 'running') {
      return;
    }
    try {
      this.advanceExecutionState('outcomeUnknown');
    } catch {
      // 数据库不可用时保留 running,下一次启动恢复会转换为 outcome_unknown.
    }
  }

  private advanceExecutionState(
    transition: 'authorize' | 'start' | 'succeed' | 'fail' | 'cancel' | 'outcomeUnknown',
  ): void {
    const record = this.executionContext.toolExecutionState?.[transition](this.id);
    if (record) this.executionStatus = record.status;
  }

  private durationMs(): number {
    return Date.now() - this.registeredAt;
  }

  private invocation(signal: AbortSignal): ToolInvocation {
    return Object.freeze({
      sessionId: this.executionContext.sessionId,
      turnId: this.executionContext.turnId,
      toolCallId: this.id,
      signal,
    });
  }
}


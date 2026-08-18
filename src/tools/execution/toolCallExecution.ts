// 完成单次 Tool 调用的解析、校验、授权、执行与审计终态。
import type { ToolResultContentPart } from '@ema-agent/llm';
import {
  hasPermissionsToUseTool,
  type PermissionRequest,
  type PermissionResponse,
  type ToolPermissionContext,
} from '@ema-agent/permission';
import { ZodError } from 'zod';
import type { ToolPool } from '../assembly/toolPool.js';
import { ToolInputError } from '../errors.js';
import type { ToolExecutionEvent } from '../events.js';
import type { Tool } from '../Tool/tool.js';
import type { ToolInvocation } from '../Tool/toolInvocation.js';
import type { ToolUseContext } from '../Tool/toolUseContext.js';
import type {
  ToolExecutionStatePort,
  ToolExecutionStatus,
} from './toolExecutionState.js';
import type { ToolResultStore } from '../results/toolResultStore.js';
import type { ToolResult } from '../results/toolResult.js';

// ToolPool 是 Tool 泛型的唯一擦除边界；单调用内的同一对象负责全程。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any, any, any>;

/** 同一 Turn 内每个单调用共享的执行环境。 */
export interface ToolExecutionEnvironment {
  readonly sessionId: string;
  readonly turnId: string;
  /** 子 Agent 调用仍属于父 Turn，只额外关联自己的 AgentRun。 */
  readonly agentRunId?: string;
  /** 父执行取消信号；每个 ToolInvocation 会再派生自己的 signal。 */
  readonly abortSignal: AbortSignal;
  /** 根 Turn 已经筛选并冻结的唯一 Tool 集合。 */
  readonly toolPool: ToolPool;
  /** Turn 准备期冻结的权限判定上下文（模式 + 三桶规则 + 工作区）。 */
  readonly permissionContext: ToolPermissionContext;
  /**
   * 权限交互通道：存在即 interactive，ask 决策经它等用户回答；
   * 缺失（子 Agent/headless）时中央把 ask 收口为 deny(headless)。
   * 由 Turn 层实现（交互队列 + permission_required/resolved 事件 +
   * allowSession 的规则沉淀），执行链只消费最终回答。
   */
  readonly askPermission?: (
    request: PermissionRequest,
    signal: AbortSignal,
  ) => Promise<PermissionResponse>;
  readonly toolContext: ToolUseContext;
  readonly toolResultStore?: ToolResultStore;
  readonly toolExecutionState?: ToolExecutionStatePort;
}

export interface ToolExecutionCall {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ToolExecutionCompletion {
  readonly result: ToolResult;
  /** Runtime 按模型输出顺序发射终态；进度和审批事件不经过该缓冲。 */
  readonly terminalEvent: ToolExecutionEvent;
}

interface ToolFailure {
  readonly code: string;
  readonly message: string;
}

type ResultDisposition = 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';

/**
 * 单次工具调用的执行状态机。
 *
 * Runtime 只决定何时 run()；本对象从当前 ToolPool 取得唯一 Tool，
 * 对模型参数只 parse 一次，然后让校验、Permission 和 execute 共用该局部输入。
 */
export class ToolCallExecution {
  readonly id: string;
  readonly name: string;
  readonly isConcurrencySafe: boolean;
  readonly requiresUserInteraction: boolean;
  readonly maxResultBytes?: number;

  private readonly startedAt = Date.now();
  private readonly abortController = new AbortController();
  private readonly tool?: AnyTool;
  private readonly input?: unknown;
  private readonly preflightFailure?: ToolFailure;
  private executionStatus?: ToolExecutionStatus;
  private result?: ToolResult;
  private terminalEvent?: ToolExecutionEvent;
  private resultDisposition?: ResultDisposition;
  private runPromise?: Promise<ToolExecutionCompletion>;

  constructor(
    private readonly environment: ToolExecutionEnvironment,
    call: ToolExecutionCall,
    private readonly emit: (event: ToolExecutionEvent) => void,
  ) {
    this.id = call.callId;
    this.name = call.name;

    const tool = environment.toolPool.get(call.name);
    if (!tool) {
      this.preflightFailure = toolUnavailable(call.name);
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
      this.maxResultBytes = tool.maxResultBytes;
    } catch (error) {
      this.preflightFailure = classifyInputFailure(call.name, error);
      this.isConcurrencySafe = true;
      this.requiresUserInteraction = false;
    }
  }

  /** 取消当前调用，不影响同 Turn 的其他工具。 */
  abort(reason = 'user_abort'): void {
    this.abortController.abort(reason);
  }

  /**
   * Runtime 停止等待后关闭审计状态。
   * running 已越过副作用边界，只能标记 outcome_unknown；尚未运行则安全取消。
   */
  closeAfterShutdown(): void {
    if (this.executionStatus === 'running') {
      this.tryMarkOutcomeUnknown();
      return;
    }
    if (this.executionStatus === 'prepared' || this.executionStatus === 'authorized') {
      try {
        this.environment.toolExecutionState?.cancel(this.id);
        if (this.environment.toolExecutionState) this.executionStatus = 'cancelled';
      } catch {
        // 启动恢复会清理尚未越过副作用边界的记录。
      }
    }
  }

  /** 同一个调用对象无论被等待几次，都只会越过一次副作用边界。 */
  run(): Promise<ToolExecutionCompletion> {
    this.runPromise ??= this.runOnce();
    return this.runPromise;
  }

  /** Tool Result 已写入 Message 后，才把薄执行状态推进到终态。 */
  commitResult(): void {
    if (!this.result || !this.resultDisposition) {
      throw new Error(`tool_result_not_ready: ${this.id}`);
    }
    if (!isExecutionNonTerminal(this.executionStatus)) return;

    if (this.resultDisposition === 'succeeded') {
      this.environment.toolExecutionState?.succeed(this.id);
      if (this.environment.toolExecutionState) this.executionStatus = 'succeeded';
      return;
    }
    // 越过副作用边界(running)后的取消无法证明干净,只能按 outcome_unknown 关账。
    if (
      this.resultDisposition === 'outcome_unknown'
      || (this.executionStatus === 'running' && this.resultDisposition === 'cancelled')
    ) {
      this.environment.toolExecutionState?.outcomeUnknown(this.id);
      if (this.environment.toolExecutionState) this.executionStatus = 'outcome_unknown';
      return;
    }
    if (this.resultDisposition === 'cancelled') {
      this.environment.toolExecutionState?.cancel(this.id);
      if (this.environment.toolExecutionState) this.executionStatus = 'cancelled';
      return;
    }
    this.environment.toolExecutionState?.fail(this.id);
    if (this.environment.toolExecutionState) this.executionStatus = 'failed';
  }

  private async runOnce(): Promise<ToolExecutionCompletion> {
    const parentSignal = this.environment.abortSignal;
    const onParentAbort = (): void => this.abort('turn_abort');
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    if (parentSignal.aborted) this.abort('turn_abort');

    try {
      await this.executePipeline();
    } catch (error) {
      if (isCancelled(this.abortController.signal, parentSignal)) {
        this.completeCancellation();
      } else if (!this.result) {
        await this.completeFailure({
          code: 'tool/internal_error',
          message: errorMessage(error),
        });
      }
    } finally {
      parentSignal.removeEventListener('abort', onParentAbort);
    }

    if (!this.result || !this.terminalEvent) {
      const message = 'Tool execution failed unexpectedly';
      this.result = this.errorResult('tool/internal_error', message);
      this.terminalEvent = this.errorEvent('tool/internal_error', message);
      this.resultDisposition = 'failed';
    }
    return { result: this.result, terminalEvent: this.terminalEvent };
  }

  private async executePipeline(): Promise<void> {
    const signal = this.abortController.signal;
    if (signal.aborted || this.environment.abortSignal.aborted) {
      this.completeCancellation();
      return;
    }
    if (this.preflightFailure) {
      await this.completeFailure(this.preflightFailure);
      return;
    }

    // 构造器只有在 Tool 存在且 Schema 解析成功时才不会设置 preflightFailure。
    const tool = this.tool!;
    const invocation = this.invocation(signal);
    const contextProjection = tool.validateContext(this.environment.toolContext);
    if (!contextProjection.valid) {
      await this.completeFailure({
        code: 'tool/context_unavailable',
        message: contextProjection.reason,
      });
      return;
    }

    if (!await this.validateInput(tool, this.input, contextProjection.context, invocation)) return;
    if (!await this.prepareExecutionState(tool)) return;

    if (!await this.requestPermission(tool, this.input, contextProjection.context)) return;

    this.environment.toolExecutionState?.authorize(this.id);
    if (this.environment.toolExecutionState) this.executionStatus = 'authorized';
    await this.executeTool(tool, this.input, contextProjection.context, invocation);
  }

  private async validateInput(
    tool: AnyTool,
    input: unknown,
    narrowedContext: unknown,
    invocation: ToolInvocation,
  ): Promise<boolean> {
    try {
      const validation = await tool.validateInput?.(input, narrowedContext, invocation)
        ?? { valid: true as const };
      if (validation.valid) return true;
      await this.completeFailure({
        code: validation.code ?? 'tool/invalid_input',
        message: validation.message,
      });
      return false;
    } catch (error) {
      await this.completeFailure({
        code: 'tool/validation_error',
        message: errorMessage(error),
      });
      return false;
    }
  }

  private async prepareExecutionState(tool: AnyTool): Promise<boolean> {
    try {
      const record = this.environment.toolExecutionState?.prepare({
        callId: this.id,
        sessionId: this.environment.sessionId,
        turnId: this.environment.turnId,
        agentRunId: this.environment.agentRunId,
        toolName: tool.name,
      });
      if (record) this.executionStatus = record.status;
      return true;
    } catch (error) {
      await this.completeFailure({
        code: 'tool/journal_prepare_failed',
        message: errorMessage(error),
      });
      return false;
    }
  }

  /**
   * 中央固定优先级判定 → allow 放行 / deny 失败 / ask 走交互通道。
   * 规则沉淀（allowSession → PermissionUpdate）由 askPermission 的实现方
   * 在等回答时完成，执行链不接触 settings。
   */
  private async requestPermission(
    tool: AnyTool,
    input: unknown,
    narrowedContext: unknown,
  ): Promise<boolean> {
    const { sessionId, turnId, permissionContext, askPermission } = this.environment;
    const signal = this.abortController.signal;

    try {
      const decision = await hasPermissionsToUseTool(
        tool,
        input,
        narrowedContext,
        permissionContext,
        { interactive: askPermission !== undefined },
      );
      if (decision.behavior === 'allow') return true;
      if (decision.behavior === 'deny') {
        await this.completeFailure({
          code: 'permission/denied',
          message: decision.message,
        });
        return false;
      }

      // ask：无交互通道时中央已收口 deny，能到这里 askPermission 必然存在。
      const summary = tool.getToolUseSummary?.(input);
      const response = await askPermission!({
        toolName: tool.name,
        ...(summary ? { toolDescription: summary } : {}),
        input,
        ...(decision.decisionReason ? { decisionReason: decision.decisionReason } : {}),
        ...(decision.ruleSuggestion ? { ruleSuggestion: decision.ruleSuggestion } : {}),
        sessionId,
        turnId,
        toolCallId: this.id,
      }, signal);

      if (isCancelled(signal, this.environment.abortSignal)) {
        this.completeCancellation();
        return false;
      }
      if (response.action === 'allow' || response.action === 'allowSession') return true;
      await this.completeFailure({
        code: 'permission/denied',
        message: response.reason ?? '用户拒绝了本次调用',
      });
      return false;
    } catch (error) {
      if (isCancelled(signal, this.environment.abortSignal)) {
        this.completeCancellation();
      } else {
        await this.completeFailure({
          code: 'permission/error',
          message: errorMessage(error),
        });
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
    const { sessionId, turnId } = this.environment;
    const signal = this.abortController.signal;
    let output: unknown;

    try {
      // running 是副作用边界；该状态持久化成功后才能调用具体工具。
      this.environment.toolExecutionState?.start(this.id);
      if (this.environment.toolExecutionState) this.executionStatus = 'running';
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

      if (signal.aborted && !this.environment.abortSignal.aborted) output = annotateAborted(output);

      this.terminalEvent = {
        type: 'tool_result',
        sessionId,
        callId: this.id,
        name: this.name,
        output,
        durationMs: this.durationMs(),
      };
    } catch (error) {
      if (signal.aborted && !this.environment.abortSignal.aborted) {
        output = '[用户中途终止]';
        this.completeCancellation();
        return;
      } else if (this.environment.abortSignal.aborted) {
        this.completeCancellation();
        return;
      } else {
        await this.completeFailure(classifyExecutionFailure(error));
        return;
      }
    }

    this.result = {
      type: 'tool_result',
      toolCallId: this.id,
      content: this.normalizeResult(tool, output),
      data: output,
      isError: false,
      durationMs: this.durationMs(),
    };
    this.resultDisposition = 'succeeded';
  }

  private async completeFailure(failure: ToolFailure): Promise<void> {
    this.result = this.errorResult(failure.code, failure.message);
    this.terminalEvent = this.errorEvent(failure.code, failure.message);
    this.resultDisposition = failure.code === 'tool/outcome_unknown'
      ? 'outcome_unknown'
      : 'failed';
  }

  private completeCancellation(): void {
    const output = '[用户中途终止]';
    this.result = {
      type: 'tool_result',
      toolCallId: this.id,
      content: output,
      isError: true,
      durationMs: this.durationMs(),
      errorCode: 'tool/cancelled',
    };
    this.resultDisposition = 'cancelled';
    this.terminalEvent = {
      type: 'tool_result',
      sessionId: this.environment.sessionId,
      callId: this.id,
      name: this.name,
      output,
      error: { code: 'tool/cancelled', message: output },
      durationMs: this.durationMs(),
    };
  }

  /**
   * 模型可见内容 = Tool 自定义投影,缺省按"string 原样、其余 JSON 化"。
   * 文本走统一单项预算(超限外置);多模态 parts 不做文本外置,
   * 由 Tool 业务层自限尺寸(结果层没有语义能安全裁切它们)。
   */
  private normalizeResult(tool: AnyTool, output: unknown): string | ToolResultContentPart[] {
    const modelContent = tool.mapResultToModelContent?.(output) ?? serializeToolOutput(output);
    if (typeof modelContent !== 'string') return modelContent;
    const normalized = this.environment.toolResultStore?.normalize(
      this.id,
      this.name,
      modelContent,
      tool.maxResultBytes,
    );
    return !normalized || normalized.kind === 'unchanged'
      ? modelContent
      : normalized.blockContent;
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

  private errorEvent(code: string, message: string): ToolExecutionEvent {
    return {
      type: 'tool_result',
      sessionId: this.environment.sessionId,
      callId: this.id,
      name: this.name,
      error: { code, message },
      durationMs: this.durationMs(),
    };
  }

  private tryMarkOutcomeUnknown(): void {
    if (this.executionStatus !== 'running') return;
    try {
      this.environment.toolExecutionState?.outcomeUnknown(this.id);
      if (this.environment.toolExecutionState) this.executionStatus = 'outcome_unknown';
    } catch {
      // 数据库不可用时保留 running，下一次启动恢复会转换为 outcome_unknown。
    }
  }

  private durationMs(): number {
    return Date.now() - this.startedAt;
  }

  private invocation(signal: AbortSignal): ToolInvocation {
    return Object.freeze({
      sessionId: this.environment.sessionId,
      turnId: this.environment.turnId,
      agentRunId: this.environment.agentRunId,
      toolCallId: this.id,
      signal,
    });
  }
}

/** 模型幻觉或收窄后不在 Pool 中的工具名；这是查找失败，不是权限拒绝。 */
function toolUnavailable(name: string): ToolFailure {
  return {
    code: 'tool/unavailable',
    message: `Tool "${name}" is not available in the current ToolPool`,
  };
}

function classifyInputFailure(toolName: string, error: unknown): ToolFailure {
  const inputError = error instanceof ZodError
    ? new ToolInputError(toolName, error)
    : error;
  return {
    code: inputError instanceof ToolInputError
      ? 'tool/validation_failed'
      : 'tool/input_preparation_failed',
    message: errorMessage(inputError),
  };
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  const serialized = JSON.stringify(output, null, 2);
  return serialized ?? String(output);
}

/**
 * 给取消时已产出的部分输出追加终止标记。
 * stdout 特判是对 Bash 输出形状的务实迁就,让标记渲染进终端视图;
 * ToolResult 引入 typed data(TODO #4)后应由 Tool 自己声明部分输出的标注方式。
 */
function annotateAborted(output: unknown): unknown {
  const notice = '\n[用户中途终止]';
  if (
    output
    && typeof output === 'object'
    && typeof (output as Record<string, unknown>)['stdout'] === 'string'
  ) {
    const record = output as Record<string, unknown>;
    return { ...record, stdout: (record['stdout'] as string) + notice };
  }
  if (typeof output === 'string') return output + notice;
  return String(JSON.stringify(output) ?? '') + notice;
}

function classifyExecutionFailure(error: unknown): ToolFailure {
  return {
    code: 'tool/error',
    message: errorMessage(error),
  };
}

function isCancelled(toolSignal: AbortSignal, turnSignal: AbortSignal): boolean {
  return toolSignal.aborted || turnSignal.aborted;
}

function isExecutionNonTerminal(status: ToolExecutionStatus | undefined): boolean {
  return status === 'prepared' || status === 'authorized' || status === 'running';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

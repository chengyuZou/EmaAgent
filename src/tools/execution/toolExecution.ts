// 完成单次 Tool 调用的解析、校验、授权、执行与审计终态。

import type {
  AgentRunId,
  SessionId,
  ToolCallId,
  TurnId,
} from '@ema-agent/ids';
import type {
  AskPermissionFn,
  PermissionAuthorizer,
  PermissionContext,
  PermissionIntent,
  PermissionStreamEvent,
} from '@ema-agent/permission';
import { ZodError } from 'zod';
import type { ToolPool } from '../assembly/toolPool.js';
import { ToolInputError } from '../errors.js';
import type { ToolExecutionEvent, ToolFailurePhase } from '../events.js';
import type { Tool } from '../Tool/tool.js';
import type { ToolInvocation } from '../Tool/toolInvocation.js';
import type { ToolUseContext } from '../Tool/toolUseContext.js';
import type {
  ToolExecutionJournalPort,
  ToolExecutionStatus,
} from '../journal/toolExecutionJournal.js';
import type { ToolResultStore } from '../results/toolResultStore.js';
import type { ToolExecutionResult } from './toolExecutionResult.js';
import type { ToolLifecycleObserver } from './toolLifecycleObserver.js';

// ToolPool 是 Tool 泛型的唯一擦除边界；单调用内的同一对象负责全程。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any, any, any>;

export type ToolExecutionLiveEvent = ToolExecutionEvent | PermissionStreamEvent;

/** 同一 Turn 内每个单调用共享的执行环境。 */
export interface ToolExecutionEnvironment {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  /** 子 Agent 调用仍属于父 Turn，只额外关联自己的 AgentRun。 */
  readonly agentRunId?: AgentRunId;
  /** 父执行取消信号；每个 ToolInvocation 会再派生自己的 signal。 */
  readonly abortSignal: AbortSignal;
  /** 根 Turn 已经筛选并冻结的唯一 Tool 集合。 */
  readonly toolPool: ToolPool;
  readonly permission: PermissionAuthorizer;
  readonly permCtx: PermissionContext;
  readonly lifecycle?: ToolLifecycleObserver;
  readonly toolContext: ToolUseContext;
  readonly buildAsk?: (args: {
    sessionId: SessionId;
    turnId: TurnId;
    toolCallId: ToolCallId;
    emit: (event: PermissionStreamEvent) => void;
  }) => AskPermissionFn;
  readonly toolResultStore?: ToolResultStore;
  readonly toolExecutionJournal?: ToolExecutionJournalPort;
}

export interface ToolExecutionCall {
  readonly callId: ToolCallId;
  readonly name: string;
  readonly args: unknown;
}

export interface ToolExecutionCompletion {
  readonly result: ToolExecutionResult;
  /** Runtime 按模型输出顺序发射终态；进度和审批事件不经过该缓冲。 */
  readonly terminalEvent: ToolExecutionEvent;
}

interface ToolFailure {
  readonly phase: ToolFailurePhase;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * 单次工具调用的执行状态机。
 *
 * Runtime 只决定何时 run()；本对象从当前 ToolPool 取得唯一 Tool，
 * 对模型参数只 parse 一次，然后让校验、Permission 和 execute 共用该局部输入。
 */
export class ToolExecution {
  readonly id: ToolCallId;
  readonly name: string;
  readonly isConcurrencySafe: boolean;
  readonly requiresUserInteraction: boolean;
  readonly maxResultBytes?: number;

  private readonly startedAt = Date.now();
  private readonly abortController = new AbortController();
  private readonly tool?: AnyTool;
  private readonly input?: unknown;
  private readonly preflightFailure?: ToolFailure;
  private journalStatus?: ToolExecutionStatus;
  private result?: ToolExecutionResult;
  private terminalEvent?: ToolExecutionEvent;
  private cancellationReason?: string;
  private runPromise?: Promise<ToolExecutionCompletion>;

  constructor(
    private readonly environment: ToolExecutionEnvironment,
    call: ToolExecutionCall,
    private readonly emit: (event: ToolExecutionLiveEvent) => void,
  ) {
    this.id = call.callId;
    this.name = call.name;

    const tool = environment.toolPool.get(call.name);
    if (!tool) {
      this.preflightFailure = policyDenied(call.name);
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
    this.cancellationReason = reason;
    this.abortController.abort(reason);
  }

  /**
   * Runtime 停止等待后关闭审计状态。
   * running 已越过副作用边界，只能标记 outcome_unknown；尚未运行则安全取消。
   */
  closeAfterShutdown(reason: string): void {
    if (this.journalStatus === 'running') {
      this.tryMarkOutcomeUnknown(`Turn 已终止但工具未在时限内退出：${reason}`);
      return;
    }
    if (this.journalStatus === 'prepared' || this.journalStatus === 'authorized') {
      try {
        this.environment.toolExecutionJournal?.cancel(this.id, reason);
        if (this.environment.toolExecutionJournal) this.journalStatus = 'cancelled';
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

  private async runOnce(): Promise<ToolExecutionCompletion> {
    const parentSignal = this.environment.abortSignal;
    const onParentAbort = (): void => this.abort('turn_abort');
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    if (parentSignal.aborted) this.abort('turn_abort');

    try {
      await this.executePipeline();
    } catch (error) {
      if (isCancelled(this.abortController.signal, parentSignal)) {
        this.completeCancellation(this.cancellationReason ?? 'user_abort');
      } else if (!this.result) {
        await this.completeFailure({
          phase: 'execution',
          code: 'tool/internal_error',
          message: errorMessage(error),
          retryable: false,
        });
      }
    } finally {
      parentSignal.removeEventListener('abort', onParentAbort);
    }

    if (!this.result || !this.terminalEvent) {
      const message = 'Tool execution failed unexpectedly';
      this.result = this.errorResult('tool/internal_error', message);
      this.terminalEvent = this.errorEvent('tool/internal_error', message);
    }
    return { result: this.result, terminalEvent: this.terminalEvent };
  }

  private async executePipeline(): Promise<void> {
    const signal = this.abortController.signal;
    if (signal.aborted || this.environment.abortSignal.aborted) {
      this.completeCancellation(this.cancellationReason ?? 'turn_abort');
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
        phase: 'validation',
        code: 'tool/context_unavailable',
        message: contextProjection.reason,
        retryable: false,
      });
      return;
    }

    if (!await this.validateInput(tool, this.input, contextProjection.context, invocation)) return;
    if (!await this.prepareJournal(tool, this.input)) return;

    await this.environment.lifecycle?.beforeToolUse(
      { callId: this.id, name: this.name, args: this.input },
      {
        turnId: this.environment.turnId,
        sessionId: this.environment.sessionId,
        signal,
      },
    );

    if (!await this.requestPermission(tool, this.input, contextProjection.context)) return;

    this.environment.toolExecutionJournal?.authorize(this.id);
    if (this.environment.toolExecutionJournal) this.journalStatus = 'authorized';
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
        phase: 'validation',
        code: validation.code ?? 'tool/invalid_input',
        message: validation.message,
        retryable: validation.retryable ?? true,
      });
      return false;
    } catch (error) {
      await this.completeFailure({
        phase: 'validation',
        code: 'tool/validation_error',
        message: errorMessage(error),
        retryable: true,
      });
      return false;
    }
  }

  private async prepareJournal(tool: AnyTool, input: unknown): Promise<boolean> {
    try {
      const record = this.environment.toolExecutionJournal?.prepare({
        callId: this.id,
        sessionId: this.environment.sessionId,
        turnId: this.environment.turnId,
        agentRunId: this.environment.agentRunId,
        toolName: tool.id,
        input,
      });
      if (record) this.journalStatus = record.status;
      return true;
    } catch (error) {
      await this.completeFailure({
        phase: 'persistence',
        code: 'tool/journal_prepare_failed',
        message: errorMessage(error),
        retryable: false,
      }, true);
      return false;
    }
  }

  private async requestPermission(
    tool: AnyTool,
    input: unknown,
    narrowedContext: unknown,
  ): Promise<boolean> {
    const { sessionId, turnId, permission, permCtx, buildAsk } = this.environment;
    const signal = this.abortController.signal;
    const permissionContext: PermissionContext = {
      ...permCtx,
      sessionId,
      turnId,
      toolCallId: this.id,
    };
    const ask = buildAsk?.({
      sessionId,
      turnId,
      toolCallId: this.id,
      emit: this.emit,
    });

    try {
      const declaredIntent = await tool.getPermissionIntent(input, narrowedContext);
      const summary = tool.getToolUseSummary?.(input);
      const outcome = await permission.authorize({
        tool: {
          id: tool.id,
          name: tool.name,
          ...(summary ? { description: summary } : {}),
        },
        input,
        intent: enforceOriginPermission(tool, declaredIntent),
        context: permissionContext,
      }, ask);
      if (outcome.outcome === 'allow') return true;

      await this.completeFailure({
        phase: 'permission',
        code: 'permission/denied',
        message: outcome.message,
        retryable: false,
      });
      return false;
    } catch (error) {
      if (isCancelled(signal, this.environment.abortSignal)) {
        this.completeCancellation(this.cancellationReason ?? 'user_abort');
      } else {
        await this.completeFailure({
          phase: 'permission',
          code: 'permission/error',
          message: errorMessage(error),
          retryable: true,
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
    const { lifecycle, sessionId, turnId } = this.environment;
    const signal = this.abortController.signal;
    let output: unknown;

    try {
      // running 是副作用边界；该状态持久化成功后才能调用具体工具。
      this.environment.toolExecutionJournal?.start(this.id);
      if (this.environment.toolExecutionJournal) this.journalStatus = 'running';
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

      try {
        this.environment.toolExecutionJournal?.succeed(this.id, output);
        if (this.environment.toolExecutionJournal) this.journalStatus = 'succeeded';
      } catch (error) {
        this.tryMarkOutcomeUnknown(`工具已返回，但结果日志写入失败：${errorMessage(error)}`);
        await this.completeFailure({
          phase: 'persistence',
          code: 'tool/outcome_unknown',
          message: '工具可能已经产生副作用，但执行结果未能可靠持久化，请勿自动重试',
          retryable: false,
        }, true);
        return;
      }

      this.terminalEvent = {
        type: 'tool_result',
        sessionId,
        callId: this.id,
        name: this.name,
        output,
        durationMs: this.durationMs(),
      };
      await lifecycle?.afterToolUse(
        { callId: this.id, name: this.name, output },
        { turnId, sessionId, signal },
      );
    } catch (error) {
      if (signal.aborted && !this.environment.abortSignal.aborted) {
        output = '[用户中途终止]';
        this.completeCancellation('user_abort');
      } else if (this.environment.abortSignal.aborted) {
        this.completeCancellation('turn_abort');
        return;
      } else {
        await this.completeFailure(classifyExecutionFailure(error));
        return;
      }
    }

    this.result = {
      type: 'tool_result',
      toolUseId: this.id,
      content: this.normalizeResult(output, tool.maxResultBytes),
      isError: false,
      durationMs: this.durationMs(),
    };
  }

  private async completeFailure(failure: ToolFailure, skipJournal = false): Promise<void> {
    if (!skipJournal) this.failJournal(failure.code, failure.message);
    this.result = this.errorResult(failure.code, failure.message);
    this.terminalEvent = this.errorEvent(failure.code, failure.message);
    await this.environment.lifecycle?.onToolFailure(
      {
        callId: this.id,
        name: this.name,
        phase: failure.phase,
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
      {
        turnId: this.environment.turnId,
        sessionId: this.environment.sessionId,
        signal: this.abortController.signal,
      },
    );
  }

  private completeCancellation(reason: string): void {
    if (this.journalStatus === 'running') {
      this.tryMarkOutcomeUnknown(`运行中的工具被取消，副作用是否完成未知：${reason}`);
    } else if (this.journalStatus === 'prepared' || this.journalStatus === 'authorized') {
      try {
        this.environment.toolExecutionJournal?.cancel(this.id, reason);
        if (this.environment.toolExecutionJournal) this.journalStatus = 'cancelled';
      } catch {
        // 终止路径不能因审计库故障再次阻塞；启动恢复会继续清理非终态记录。
      }
    }
    const output = '[用户中途终止]';
    this.result = {
      type: 'tool_result',
      toolUseId: this.id,
      content: output,
      isError: false,
      durationMs: this.durationMs(),
    };
    this.terminalEvent = {
      type: 'tool_result',
      sessionId: this.environment.sessionId,
      callId: this.id,
      name: this.name,
      output,
      durationMs: this.durationMs(),
    };
  }

  private normalizeResult(output: unknown, maxResultBytes: number): string {
    const serialized = serializeToolOutput(output);
    const normalized = this.environment.toolResultStore?.normalize(
      this.id,
      this.name,
      serialized,
      maxResultBytes,
    );
    return !normalized || normalized.kind === 'unchanged'
      ? serialized
      : normalized.blockContent;
  }

  private errorResult(code: string, message: string): ToolExecutionResult {
    return {
      type: 'tool_result',
      toolUseId: this.id,
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

  private failJournal(code: string, message: string): void {
    if (!isJournalNonTerminal(this.journalStatus)) return;
    try {
      this.environment.toolExecutionJournal?.fail(this.id, code, message);
      if (this.environment.toolExecutionJournal) this.journalStatus = 'failed';
    } catch {
      // 工具未成功时仍可返回错误；原状态留给启动恢复处理。
    }
  }

  private tryMarkOutcomeUnknown(reason: string): void {
    if (this.journalStatus !== 'running') return;
    try {
      this.environment.toolExecutionJournal?.outcomeUnknown(this.id, reason);
      if (this.environment.toolExecutionJournal) this.journalStatus = 'outcome_unknown';
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

function policyDenied(name: string): ToolFailure {
  return {
    phase: 'policy',
    code: 'policy/denied',
    message: `Tool "${name}" is not available in the current ToolPool`,
    retryable: false,
  };
}

function classifyInputFailure(toolName: string, error: unknown): ToolFailure {
  const inputError = error instanceof ZodError
    ? new ToolInputError(toolName, error)
    : error;
  return {
    phase: 'validation',
    code: inputError instanceof ToolInputError
      ? 'tool/validation_failed'
      : 'tool/input_preparation_failed',
    message: errorMessage(inputError),
    retryable: inputError instanceof ToolInputError,
  };
}

/** MCP Server 只能申报更严格的意图，不能把自己降级为低风险或免询问。 */
function enforceOriginPermission(tool: AnyTool, intent: PermissionIntent): PermissionIntent {
  if (tool.origin.kind === 'builtin') return intent;
  return {
    ...intent,
    riskLevel: intent.riskLevel === 'high' ? 'high' : 'medium',
    accessType: 'execute',
    promptPolicy: 'whenRequired',
  };
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  const serialized = JSON.stringify(output, null, 2);
  return serialized ?? String(output);
}

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
    phase: 'execution',
    code: 'tool/error',
    message: errorMessage(error),
    retryable: false,
  };
}

function isCancelled(toolSignal: AbortSignal, turnSignal: AbortSignal): boolean {
  return toolSignal.aborted || turnSignal.aborted;
}

function isJournalNonTerminal(status: ToolExecutionStatus | undefined): boolean {
  return status === 'prepared' || status === 'authorized' || status === 'running';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

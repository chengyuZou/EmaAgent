// 完成一次工具调用从准备、审批、执行到审计终态的完整流水线。

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
  PermissionStreamEvent,
} from '@ema-agent/permission';
import { ToolInputError } from '../errors.js';
import type { ToolExecutionEvent, ToolFailurePhase } from '../events.js';
import type {
  ToolExecutionJournalPort,
  ToolExecutionStatus,
} from '../journal/toolExecutionJournal.js';
import type { PreparedToolCall } from '../preparation/preparedToolCall.js';
import type { ToolRegistry } from '../assembly/toolRegistry.js';
import type { ToolResultStore } from '../results/toolResultStore.js';
import type { ExecutableToolManifestSnapshot } from '../types.js';
import type { ToolExecutionResult } from './toolExecutionResult.js';
import type { ToolLifecycleObserver } from './toolLifecycleObserver.js';

export type ToolExecutionLiveEvent = ToolExecutionEvent | PermissionStreamEvent;

export interface ToolExecutionHostContext {
  readonly signal: AbortSignal;
  readonly agentRunId?: AgentRunId;
}

/** 同一 Turn 内每个单调用共享的执行环境。 */
export interface ToolExecutionEnvironment<THostContext extends ToolExecutionHostContext> {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  /** 调用执行前再次检查当前能力范围，防止排队期间能力被收窄。 */
  readonly allows: (name: string) => boolean;
  readonly toolManifest: ExecutableToolManifestSnapshot;
  readonly tools: ToolRegistry;
  readonly permission: PermissionAuthorizer;
  readonly permCtx: PermissionContext;
  readonly lifecycle?: ToolLifecycleObserver;
  readonly toolContext: THostContext;
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
 * Runtime 只负责何时调用 run()；该对象独占输入准备、动态策略复核、Context
 * 投影、业务校验、权限、Journal 和工具结果终态，避免静态与流式路径各写一套。
 */
export class ToolExecution<THostContext extends ToolExecutionHostContext> {
  readonly id: ToolCallId;
  readonly name: string;
  readonly isConcurrencySafe: boolean;
  readonly requiresUserInteraction: boolean;
  readonly maxResultBytes?: number;

  private readonly startedAt = Date.now();
  private readonly abortController = new AbortController();
  private readonly prepared?: PreparedToolCall;
  private readonly preflightFailure?: ToolFailure;
  private readonly rawArgs: unknown;
  private journalStatus?: ToolExecutionStatus;
  private result?: ToolExecutionResult;
  private terminalEvent?: ToolExecutionEvent;
  private cancellationReason?: string;
  private runPromise?: Promise<ToolExecutionCompletion>;

  constructor(
    private readonly environment: ToolExecutionEnvironment<THostContext>,
    call: ToolExecutionCall,
    private readonly emit: (event: ToolExecutionLiveEvent) => void,
  ) {
    this.id = call.callId;
    this.name = call.name;
    this.rawArgs = call.args;

    let prepared: PreparedToolCall | undefined;
    let preflightFailure: ToolFailure | undefined;
    if (!environment.allows(call.name)) {
      preflightFailure = policyDenied(call.name, false);
    } else {
      try {
        prepared = environment.tools.prepare(
          call.name,
          call.args,
          environment.toolManifest,
        );
      } catch (error) {
        preflightFailure = classifyPreparationFailure(error);
      }
    }

    this.prepared = prepared;
    this.preflightFailure = preflightFailure;
    this.isConcurrencySafe = prepared?.isConcurrencySafe ?? true;
    this.requiresUserInteraction = prepared?.requiresUserInteraction ?? false;
    this.maxResultBytes = prepared?.maxResultBytes;

    // prepare 是模型工具意图被接纳的时刻，必须先于调度和任何副作用持久化。
    if (environment.toolExecutionJournal) {
      const record = environment.toolExecutionJournal.prepare({
        callId: call.callId,
        sessionId: environment.sessionId,
        turnId: environment.turnId,
        agentRunId: environment.toolContext.agentRunId,
        toolName: prepared?.id ?? call.name,
        input: prepared?.input ?? call.args,
      });
      this.journalStatus = record?.status ?? 'prepared';
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
    const parentSignal = this.environment.toolContext.signal;
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
    const { sessionId, turnId, lifecycle, tools, toolContext } = this.environment;
    const signal = this.abortController.signal;
    const args = this.prepared?.input ?? this.callArgs();

    if (signal.aborted || toolContext.signal.aborted) {
      this.completeCancellation(this.cancellationReason ?? 'turn_abort');
      return;
    }

    await lifecycle?.beforeToolUse(
      { callId: this.id, name: this.name, args },
      { turnId, sessionId, signal },
    );

    if (!this.environment.allows(this.name)) {
      await this.completeFailure(policyDenied(this.name, true));
      return;
    }
    if (this.preflightFailure) {
      await this.completeFailure(this.preflightFailure);
      return;
    }
    if (!this.prepared) {
      await this.completeFailure({
        phase: 'validation',
        code: 'tool/preparation_missing',
        message: `Tool "${this.name}" has no prepared input`,
        retryable: false,
      });
      return;
    }

    const hostContext = {
      ...toolContext,
      toolCallId: this.id,
      signal,
      emit: this.emit,
    };
    const contextProjection = tools.validateContext(this.prepared, hostContext);
    if (!contextProjection.valid) {
      await this.completeFailure({
        phase: 'validation',
        code: 'tool/context_unavailable',
        message: contextProjection.reason,
        retryable: false,
      });
      return;
    }

    let validation;
    try {
      validation = await tools.validate(this.prepared, contextProjection.context);
    } catch (error) {
      await this.completeFailure({
        phase: 'validation',
        code: 'tool/validation_error',
        message: errorMessage(error),
        retryable: true,
      });
      return;
    }
    if (!validation.valid) {
      await this.completeFailure({
        phase: 'validation',
        code: validation.code ?? 'tool/invalid_input',
        message: validation.message,
        retryable: validation.retryable ?? true,
      });
      return;
    }

    if (!await this.requestPermission(contextProjection.context)) return;

    this.environment.toolExecutionJournal?.authorize(this.id);
    if (this.environment.toolExecutionJournal) this.journalStatus = 'authorized';
    await this.executePrepared(contextProjection.context);
  }

  private async requestPermission(narrowedContext: unknown): Promise<boolean> {
    const {
      sessionId,
      turnId,
      permission,
      permCtx,
      buildAsk,
      toolContext,
    } = this.environment;
    const prepared = this.prepared!;
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

    let outcome;
    try {
      const intent = await this.environment.tools.permissionIntent(prepared, narrowedContext);
      outcome = await permission.authorize({
        tool: {
          id: prepared.id,
          name: this.name,
          ...(prepared.summary ? { description: prepared.summary } : {}),
        },
        input: prepared.input,
        intent,
        context: permissionContext,
      }, ask);
    } catch (error) {
      if (isCancelled(signal, toolContext.signal)) {
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
    if (outcome.outcome === 'allow') return true;

    await this.completeFailure({
      phase: 'permission',
      code: 'permission/denied',
      message: outcome.message,
      retryable: false,
    });
    return false;
  }

  private async executePrepared(narrowedContext: unknown): Promise<void> {
    const { tools, toolContext, lifecycle, sessionId, turnId } = this.environment;
    const signal = this.abortController.signal;
    let output: unknown;

    try {
      // running 是副作用边界；该状态持久化成功后才能调用具体工具。
      this.environment.toolExecutionJournal?.start(this.id);
      if (this.environment.toolExecutionJournal) this.journalStatus = 'running';
      output = await tools.execute(this.prepared!, narrowedContext);

      if (signal.aborted && !toolContext.signal.aborted) output = annotateAborted(output);

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
      if (signal.aborted && !toolContext.signal.aborted) {
        output = '[用户中途终止]';
        this.completeCancellation('user_abort');
      } else if (toolContext.signal.aborted) {
        this.completeCancellation('turn_abort');
        return;
      } else {
        await this.completeFailure(classifyExecutionFailure(error));
        return;
      }
    }

    const content = this.normalizeResult(output);
    this.result = {
      type: 'tool_result',
      toolUseId: this.id,
      content,
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

  private normalizeResult(output: unknown): string {
    const serialized = serializeToolOutput(output);
    const store = this.environment.toolResultStore;
    if (!store || !this.prepared) return serialized;
    const normalized = store.normalize(
      this.id,
      this.name,
      serialized,
      this.prepared.maxResultBytes,
    );
    return normalized.kind === 'unchanged' ? serialized : normalized.blockContent;
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

  private callArgs(): unknown {
    return this.rawArgs;
  }

  private durationMs(): number {
    return Date.now() - this.startedAt;
  }
}

function policyDenied(name: string, changedWhileQueued: boolean): ToolFailure {
  return {
    phase: 'policy',
    code: 'policy/denied',
    message: changedWhileQueued
      ? `Tool "${name}" is no longer available in the current capability scope`
      : `Tool "${name}" is not available in this mode`,
    retryable: false,
  };
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  const serialized = JSON.stringify(output, null, 2);
  return serialized ?? String(output);
}

function annotateAborted(output: unknown): unknown {
  const notice = '\n[用户中途终止]';
  if (output && typeof output === 'object' && typeof (output as Record<string, unknown>)['stdout'] === 'string') {
    const record = output as Record<string, unknown>;
    return { ...record, stdout: (record['stdout'] as string) + notice };
  }
  if (typeof output === 'string') return output + notice;
  return String(JSON.stringify(output) ?? '') + notice;
}

function classifyPreparationFailure(error: unknown): ToolFailure {
  if (error instanceof ToolInputError) {
    return {
      phase: 'validation',
      code: 'tool/validation_failed',
      message: error.message,
      retryable: true,
    };
  }
  return {
    phase: 'validation',
    code: 'tool/preparation_failed',
    message: errorMessage(error),
    retryable: false,
  };
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

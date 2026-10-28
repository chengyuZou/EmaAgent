import { ZodError } from 'zod';
import { ToolExecutionError, ToolInputError } from '../errors.js';
import type { ToolError, ToolExecutionEvent } from './toolEvents.js';
import type { ToolResult } from '../results/toolResult.js';
import type { ToolExecutionStatus } from './toolExecutionState.js';

export type ToolOutcomeStatus = 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';

export interface ToolCallOutcome {
  readonly result: ToolResult;
  readonly terminalEvent: Extract<ToolExecutionEvent, { type: 'tool_result' }>;
  // 结果已生成但尚未落库. 调用方保存 Message 后, 才将此结论写入执行状态.
  readonly status: ToolOutcomeStatus;
}

export function outcomeStatusForFailure(code: string): ToolOutcomeStatus {
  if (code === 'tool/outcome_unknown') return 'outcome_unknown';
  if (code === 'tool/cancelled') return 'cancelled';
  return 'failed';
}

export function executionStatusForOutcome(
  outcome: ToolOutcomeStatus,
  executionStatus: ToolExecutionStatus | undefined,
  cancellationReason: unknown,
): ToolOutcomeStatus {
  // 普通取消只说明停止等待. 已开始执行时不能据此断言没有产生副作用.
  // ComputerUse 经 Turn 提供的回调用 ToolExecutionError 取消旧调用, 表示动作尚未提交.
  if (outcome === 'cancelled' && executionStatus === 'running'
    && !(cancellationReason instanceof ToolExecutionError)) {
    return 'outcome_unknown';
  }
  return outcome;
}

/** 模型幻觉或收窄后不在 Pool 中的工具名;这是查找失败,不是权限拒绝. */
export function toolUnavailable(name: string): ToolError {
  return {
    code: 'tool/unavailable',
    message: `Tool "${name}" is not available in the current ToolPool`,
  };
}

export function classifyCallPreparationError(toolName: string, error: unknown): ToolError {
  if (error instanceof ToolExecutionError) {
    return { code: error.code, message: error.message };
  }
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

export function serializeToolOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  const serialized = JSON.stringify(output, null, 2);
  return serialized ?? String(output);
}

export function classifyExecutionFailure(error: unknown): ToolError {
  return { code: error instanceof ToolExecutionError ? error.code : 'tool/error', message: errorMessage(error) };
}

export function isCancelled(toolSignal: AbortSignal, turnSignal: AbortSignal): boolean {
  return toolSignal.aborted || turnSignal.aborted;
}

export function isExecutionNonTerminal(status: ToolExecutionStatus | undefined): boolean {
  return status === 'prepared' || status === 'authorized' || status === 'running';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

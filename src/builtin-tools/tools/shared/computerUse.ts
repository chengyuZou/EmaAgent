import { ComputerUseError, type ComputerUse } from '@ema-agent/computer-use';
import { contextFail, contextOk, ToolExecutionError, type ToolUseContext } from '@ema-agent/tools';

export interface ComputerToolContext {
  readonly computer: ComputerUse;
}

export function computerContext(context: ToolUseContext) {
  if (!context.computerUse) return contextFail<ComputerToolContext>('当前宿主没有可用的 Windows 电脑操控程序.');
  return contextOk<ComputerToolContext>({ computer: context.computerUse });
}

export function computerToolError(error: unknown): ToolExecutionError {
  if (error instanceof ToolExecutionError) return error;
  if (error instanceof ComputerUseError) {
    return new ToolExecutionError(
      { effect: error.effect, message: error.message },
      error.message,
      error.code,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ToolExecutionError(undefined, message, 'computer/error');
}

export const computerPermission = {
  kind: 'computerUse' as const,
  needsStartupApproval: false,
};

import { ComputerUseError, type ComputerCallKind, type ComputerUse } from '@ema-agent/computer-use';
import { BuiltinTools, ToolExecutionError, type StreamingToolExecutorOptions } from '@ema-agent/tools';

const computerToolKinds = new Map<string, ComputerCallKind>([
  [BuiltinTools.ListWindows.name, 'list'],
  [BuiltinTools.ObserveWindow.name, 'observe'],
  [BuiltinTools.ComputerAction.name, 'action'],
  [BuiltinTools.ComputerEnd.name, 'end'],
]);

/** 只绑定主 Agent. 电脑操控身份与暂停状态仍由共享 ComputerUse 保存. */
export function createComputerToolHooks(
  computer: ComputerUse | undefined,
  sessionId: string,
): Pick<StreamingToolExecutorOptions, 'registerToolCall' | 'waitBeforeToolExecution'> {
  return {
    registerToolCall: (call, cancelUnsubmittedCall) => {
      const kind = computerToolKinds.get(call.name);
      if (!computer || !kind) return undefined;
      try {
        return computer.registerCall(sessionId, call.callId, kind, error => {
          cancelUnsubmittedCall(new ToolExecutionError({ effect: error.effect }, error.message, error.code));
        });
      } catch (error) {
        if (error instanceof ComputerUseError) {
          throw new ToolExecutionError(undefined, error.message, error.code);
        }
        throw error;
      }
    },
    waitBeforeToolExecution: async (call, signal) => {
      // 旧电脑调用由 registerCall 直接结清. 其他工具在启动前共用主 Agent 的暂停等待.
      if (!computerToolKinds.has(call.name)) await computer?.waitWhilePaused(sessionId, signal);
    },
  };
}

import { ComputerUseError, type ComputerCallKind, type ComputerUse } from '@ema-agent/computer-use';
import { BuiltinTools, ToolExecutionError, type StreamingToolExecutorOptions } from '@ema-agent/tools';

const computerToolKinds = new Map<string, ComputerCallKind>([
  [BuiltinTools.ListWindows.name, 'list'],
  [BuiltinTools.ObserveWindow.name, 'observe'],
  [BuiltinTools.ComputerAction.name, 'action'],
  [BuiltinTools.ComputerEnd.name, 'end'],
]);

/** 只绑定主 Agent. 电脑操控身份与运行状态仍由共享 ComputerUse 保存. */
export function createComputerToolHooks(
  computer: ComputerUse | undefined,
  sessionId: string,
  turnId: string,
): Pick<StreamingToolExecutorOptions, 'registerComputerToolCall'> {
  return {
    registerComputerToolCall: (call, cancelPendingComputerCall) => {
      const kind = computerToolKinds.get(call.name);
      if (!computer || !kind) return undefined;
      try {
        // 结束时, ComputerUse 取消仍可作废的旧调用. 执行器把原因转成该 Tool 的结果.
        // 返回的函数交回执行器, 调用结束后删除登记, 并释放未启动的操控预约.
        return computer.registerCall(sessionId, turnId, call.callId, kind, error => {
          cancelPendingComputerCall(new ToolExecutionError({ effect: error.effect }, error.message, error.code));
        });
      } catch (error) {
        if (error instanceof ComputerUseError) {
          throw new ToolExecutionError(undefined, error.message, error.code);
        }
        throw error;
      }
    },
  };
}

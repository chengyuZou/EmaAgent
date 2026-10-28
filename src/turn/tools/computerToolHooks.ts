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
): Pick<StreamingToolExecutorOptions, 'registerComputerToolCall' | 'waitIfComputerUsePaused'> {
  return {
    registerComputerToolCall: (call, cancelPendingComputerCall) => {
      const kind = computerToolKinds.get(call.name);
      if (!computer || !kind) return undefined;
      try {
        // 暂停或结束时, ComputerUse 取消仍可作废的旧调用. 执行器把原因转成该 Tool 的结果.
        // 返回的函数交回执行器, 调用结束后删除登记, 并释放未启动的操控预约.
        return computer.registerCall(sessionId, call.callId, kind, error => {
          cancelPendingComputerCall(new ToolExecutionError({ effect: error.effect }, error.message, error.code));
        });
      } catch (error) {
        if (error instanceof ComputerUseError) {
          throw new ToolExecutionError(undefined, error.message, error.code);
        }
        throw error;
      }
    },
    waitIfComputerUsePaused: async (call, signal) => {
      // 电脑调用由 ComputerUse 作废或交给 Rust 返回实际结果, 不在这里等待重放.
      if (computerToolKinds.has(call.name)) return;

      // 普通工具等本 Session 的操控恢复或结束. 当前调用取消时由 signal 中断等待.
      await computer?.waitWhilePaused(sessionId, signal);
    },
  };
}

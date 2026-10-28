import { ComputerUse, NativeComputerProcess, resolveComputerExecutable } from '@ema-agent/computer-use';

export function openComputerUse(): ComputerUse | undefined {
  const executable = resolveComputerExecutable();
  if (!executable) return undefined;
  // 只有第一次实际截图或工具调用才启动原生程序, 文本聊天不启动桌面监听进程.
  return new ComputerUse(new NativeComputerProcess(executable));
}

import {
  startProcess,
  type CommandProcessHandle,
  type CommandRunOptions,
} from '@ema-agent/sandbox';

/**
 * 本机执行不使用 Bash 沙箱包装, 权限由 PowerShell 的 AST 与中央裁决决定.
 * 编码包装发生在权限裁决后, 进程输出、超时和整棵进程树停止由共享执行层处理.
 */
export function startPowerShellCommand(
  shellPath: string,
  command: string,
  options: CommandRunOptions & { cwd: string; timeoutMs: number },
): CommandProcessHandle {
  return startProcess(
    {
      executable: shellPath,
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-NoLogo',
        '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`,
      ],
      cwd: options.cwd,
      environment: process.env,
    },
    options.timeoutMs,
    options.signal,
    options.onOutput,
  );
}

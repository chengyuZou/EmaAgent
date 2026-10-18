import type { SandboxBackend, ShellSpec, WrappedCommand } from '../types.js';

/**
 * 直接交给 Shell, 不实施文件或网络隔离.
 * Server 默认不注册无 OS 隔离的 Bash 工具, 开发开关可覆盖该决定.
 * 原生 PowerShell 使用单独的执行与权限路径, 不经过这个后端.
 */
export class UnisolatedBackend implements SandboxBackend {
  wrap(command: string, shell: ShellSpec): WrappedCommand {
    if (shell.kind === 'wsl') {
      return { executable: 'wsl.exe', args: ['bash', '-c', command] };
    }
    return { executable: shell.path, args: ['-c', command] };
  }
}

// 无 OS 沙箱时原样包装命令；调用方必须先完成安全策略判定（隐藏或显式不安全覆盖）。

import type { SandboxBackend, ShellSpec, WrappedCommand } from '../types.js';

/**
 * 命令原样交给 Shell 执行，不提供任何物理隔离。
 * 后端探测只是如实报告"当前没有 OS 级隔离"，是否允许执行由
 * Server 的安全策略决定（默认隐藏执行类工具）。
 */
export class UnisolatedBackend implements SandboxBackend {
  readonly kind = 'unisolated';

  wrap(command: string, shell: ShellSpec): WrappedCommand {
    if (shell.kind === 'wsl') {
      return { executable: 'wsl.exe', args: ['bash', '-c', command] };
    }
    return { executable: shell.path, args: ['-c', command] };
  }
}

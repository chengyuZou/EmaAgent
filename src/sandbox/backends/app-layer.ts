// 无 OS 沙箱时原样包装命令，仅供 Core 显式启用不安全覆盖模式。

import { WSL_BASH_SENTINEL } from '../bashProbe.js';
import type { SandboxBackend, WrappedCommand } from '../types.js';

/**
 * 命令原样交给 Shell 执行，不提供物理隔离。Core 默认隐藏执行类工具；
 * 只有用户显式开启不安全覆盖时才会使用。
 */
export class AppLayerBackend implements SandboxBackend {
  readonly name = 'app-layer';

  wrap(command: string, shell: string): WrappedCommand {
    if (shell === WSL_BASH_SENTINEL) {
      return { executable: 'wsl.exe', args: ['bash', '-c', command] };
    }
    return { executable: shell, args: ['-c', command] };
  }
}

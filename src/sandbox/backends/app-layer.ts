// 无 OS 沙箱的降级后端：命令原样交给 shell，边界完全靠 PermissionEngine（应用层）。

import { WSL_BASH_SENTINEL } from '../types.js';
import type { SandboxBackend, SandboxConfig, WrappedCommand } from '../types.js';

// TODO isAvailable() 永远返回 true，作为最终降级兜底。SandboxBackend 接口的
//  isAvailable 冗余，待 sandbox 批次简化接口时移除。

/**
 * 应用层后端 - 无 OS 级沙箱。
 *
 * 命令原样交给 shell 执行，边界完全由 PermissionEngine（应用层）强制。用于：
 *   - 无 WSL 的 Windows
 *   - WSL1（无 Linux namespace）
 *   - 任何首选后端不可用的平台
 *   - 有 WSL2 但没装 bubblewrap 的 Windows（经 wsl.exe 路由，仍是 app-layer -
 *     无 OS 沙箱，但 bash 可用，Agent 模式可达）
 */
export class AppLayerBackend implements SandboxBackend {
  readonly name = 'app-layer';

  isAvailable(): boolean {
    return true;  // 作为最终降级，始终可用
  }

  wrap(command: string, shell: string, config: SandboxConfig): WrappedCommand {
    // Windows + WSL：没有 native bash.exe，但 WSL bash 可用。
    // 经 wsl.exe 路由，让 Agent 模式在没装 Git for Windows 时也能工作。
    if (shell === WSL_BASH_SENTINEL) {
      return { executable: 'wsl.exe', args: ['bash', '-c', command] };
    }
    return { executable: shell, args: ['-c', command] };
  }
}
import { WSL_BASH_SENTINEL } from '../types.js';
import type { SandboxBackend, SandboxConfig, WrappedCommand } from '../types.js';

/**
 * Application-layer backend — no OS sandboxing.
 *
 * The command is executed as-is with the shell; boundary enforcement comes
 * entirely from PermissionEngine (application layer). Used on:
 *   - Windows without WSL
 *   - WSL1 (no Linux namespaces)
 *   - Any platform where the preferred backend is unavailable
 *   - Windows with WSL2 but no bubblewrap (routes through wsl.exe, still
 *     app-layer — no OS sandbox, but bash is usable so Agent mode is reachable)
 */
export class AppLayerBackend implements SandboxBackend {
  readonly name = 'app-layer';

  isAvailable(): boolean {
    return true;  // Always available as the ultimate fallback
  }

  wrap(command: string, shell: string, _config: SandboxConfig): WrappedCommand {
    // Windows + WSL: no native bash.exe, but WSL bash is usable. Route the
    // command through wsl.exe so Agent mode works without Git for Windows.
    if (shell === WSL_BASH_SENTINEL) {
      return { executable: 'wsl.exe', args: ['bash', '-c', command] };
    }
    return { executable: shell, args: ['-c', command] };
  }
}

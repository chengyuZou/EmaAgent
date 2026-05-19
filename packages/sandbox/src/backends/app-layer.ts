import type { SandboxBackend, SandboxConfig, WrappedCommand } from '../types.js';

/**
 * Application-layer backend — no OS sandboxing.
 *
 * The command is executed as-is with the shell; boundary enforcement comes
 * entirely from PermissionEngine (application layer). Used on:
 *   - Windows without WSL
 *   - WSL1 (no Linux namespaces)
 *   - Any platform where the preferred backend is unavailable
 */
export class AppLayerBackend implements SandboxBackend {
  readonly name = 'app-layer';

  isAvailable(): boolean {
    return true;  // Always available as the ultimate fallback
  }

  wrap(command: string, shell: string, _config: SandboxConfig): WrappedCommand {
    return { executable: shell, args: ['-c', command] };
  }
}

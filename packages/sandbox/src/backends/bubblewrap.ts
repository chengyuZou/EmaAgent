import path from 'node:path';
import type { SandboxBackend, SandboxConfig, WrappedCommand } from '../types.js';
import { getPlatform } from '../platform.js';

/**
 * Bubblewrap backend for Linux and WSL2 (including Windows-via-WSL2).
 *
 * Strategy:
 *   1. `--ro-bind / /` — entire filesystem is read-only inside sandbox
 *   2. `--bind <allowWrite> <allowWrite>` — override specific dirs as writable
 *   3. `--ro-bind-try <denyWrite> <denyWrite>` — re-enforce read-only on specific paths
 *      (catches cases where allowWrite is a parent of a denyWrite)
 *   4. `--unshare-net` — network isolation (domain filtering is PermissionEngine's job in V1)
 *
 * On Windows the wrapper routes through wsl.exe and translates Win32 paths to
 * WSL /mnt/<drive>/... paths before building bwrap args.
 */
export class BubblewrapBackend implements SandboxBackend {
  readonly name = 'bubblewrap';

  isAvailable(): boolean {
    return true;  // Availability is confirmed by detect.ts before this is instantiated
  }

  wrap(command: string, shell: string, config: SandboxConfig): WrappedCommand {
    const platform = getPlatform();

    if (platform === 'windows') {
      return wrapViaWsl(command, shell, config);
    }

    const bwrapArgs = buildBwrapArgs(config);
    const escaped   = escapeForShell(command);

    return {
      executable: shell,
      args: ['-c', `bwrap ${bwrapArgs.join(' ')} -- ${shell} -c ${escaped}`],
    };
  }
}

// ── bwrap argument builder ────────────────────────────────────────────────────

function buildBwrapArgs(config: SandboxConfig): string[] {
  const args: string[] = [
    '--ro-bind', '/', '/',     // Entire FS read-only
    '--dev', '/dev',           // Devices (needed by many tools)
    '--proc', '/proc',         // /proc (needed by ps, etc.)
    '--die-with-parent',       // Kill sandboxed process if parent dies
  ];

  // Writable directories (override the ro root bind)
  for (const p of config.filesystem.allowWrite) {
    const resolved = path.resolve(p);
    args.push('--bind-try', resolved, resolved);
  }

  // Explicitly read-only paths (sandwich on top of any allowWrite parent)
  for (const p of config.filesystem.denyWrite) {
    const resolved = path.resolve(p);
    args.push('--ro-bind-try', resolved, resolved);
  }

  // Hidden paths (mount /dev/null over them)
  for (const p of config.filesystem.denyRead) {
    const resolved = path.resolve(p);
    args.push('--bind-try', '/dev/null', resolved);
  }

  // Network isolation
  // V1: binary choice — no allowed domains = isolate; any allowed domain = pass through.
  // Domain-level filtering inside the sandbox requires a local HTTP proxy (V2 work).
  if (config.network.allowedDomains.length === 0) {
    args.push('--unshare-net');
  }

  return args;
}

// ── Windows / WSL path translation ───────────────────────────────────────────

function wrapViaWsl(command: string, shell: string, config: SandboxConfig): WrappedCommand {
  // Translate Win32 paths to /mnt/<drive>/... for bwrap running inside WSL
  const translatedConfig: SandboxConfig = {
    filesystem: {
      allowWrite: config.filesystem.allowWrite.map(toWslPath),
      denyWrite:  config.filesystem.denyWrite.map(toWslPath),
      denyRead:   config.filesystem.denyRead.map(toWslPath),
      allowRead:  config.filesystem.allowRead.map(toWslPath),
    },
    network: config.network,
  };

  const bwrapArgs = buildBwrapArgs(translatedConfig);
  const escaped   = escapeForShell(command);
  // shell inside WSL is always bash
  const wslShell  = 'bash';

  return {
    executable: 'wsl.exe',
    args: ['bash', '-c', `bwrap ${bwrapArgs.join(' ')} -- ${wslShell} -c ${escaped}`],
  };
}

/**
 * Translate a Win32 path to its WSL /mnt/<drive> equivalent.
 * UNC paths (\\server\share) are returned unchanged — bwrap inside WSL
 * cannot bind-mount them, so they fall through to app-layer enforcement.
 */
function toWslPath(winPath: string): string {
  // UNC paths — cannot translate
  if (winPath.startsWith('\\\\')) return winPath;

  const match = winPath.match(/^([A-Za-z]):[/\\](.*)$/);
  if (!match) return winPath;

  const drive = match[1]!.toLowerCase();
  const rest  = match[2]!.replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

// ── Shell escaping ────────────────────────────────────────────────────────────

/** Wrap command in single quotes, escaping any embedded single quotes. */
function escapeForShell(command: string): string {
  return `'${command.replace(/'/g, "'\\''")}'`;
}

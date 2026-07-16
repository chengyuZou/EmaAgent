// 这里用 Bubblewrap 在 Linux 或 WSL2 中隔离命令的文件和网络访问。

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
    '--ro-bind', qp('/'), qp('/'),   // Entire FS read-only
    '--dev',     qp('/dev'),         // Devices (needed by many tools)
    '--proc',    qp('/proc'),        // /proc (needed by ps, etc.)
    '--die-with-parent',             // Kill sandboxed process if parent dies
  ];

  // Writable directories (override the ro root bind)
  for (const p of config.filesystem.allowWrite) {
    const r = qp(path.resolve(p));
    args.push('--bind-try', r, r);
  }

  // Explicitly read-only paths (sandwich on top of any allowWrite parent)
  for (const p of config.filesystem.denyWrite) {
    const r = qp(path.resolve(p));
    args.push('--ro-bind-try', r, r);
  }

  // Hidden paths (mount /dev/null over them)
  for (const p of config.filesystem.denyRead) {
    args.push('--bind-try', qp('/dev/null'), qp(path.resolve(p)));
  }

  // Network isolation
  // V1: binary choice — no allowed domains = isolate; any allowed domain = pass through.
  // Domain-level filtering inside the sandbox requires a local HTTP proxy (V2 work).
  if (config.network.access === 'none') {
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
  // shell inside WSL is always bash; path args already quoted by buildBwrapArgs via qp()
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

/**
 * Quote a filesystem path for embedding inside a shell -c string.
 * Prevents spaces or special characters in paths (e.g. workspace at
 * "/home/user/My Projects/foo") from being mis-tokenised by the outer shell.
 */
function qp(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

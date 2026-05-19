import { spawnSync } from 'node:child_process';
import { getPlatform } from './platform.js';

// ── Detection result ──────────────────────────────────────────────────────────

export type BackendKind = 'bubblewrap' | 'sandbox-exec' | 'app-layer';

export interface DetectResult {
  backend: BackendKind
  /**
   * Human-readable reason when falling back to app-layer even though the user
   * is on a platform where OS sandboxing should be available. Shown via
   * getSandboxUnavailableReason() at session startup.
   */
  degradeReason?: string
}

let cached: DetectResult | undefined;

/**
 * Detects which sandbox backend is available on this machine.
 * Result is cached for the process lifetime (shared across sessions).
 */
export function detectBackend(): DetectResult {
  if (cached) return cached;
  cached = runDetect();
  return cached;
}

/** Clear detection cache — only for tests. */
export function resetDetectCache(): void {
  cached = undefined;
}

// ── Detection logic ───────────────────────────────────────────────────────────

function runDetect(): DetectResult {
  const platform = getPlatform();

  if (platform === 'macos') {
    // sandbox-exec is a macOS system builtin, always present (though deprecated 12+)
    return { backend: 'sandbox-exec' };
  }

  if (platform === 'linux' || platform === 'wsl2') {
    return detectBwrap(
      'bwrap',
      undefined,
      'bwrap not found; install bubblewrap (e.g. apt install bubblewrap) for OS-level sandboxing',
    );
  }

  if (platform === 'wsl1') {
    return {
      backend: 'app-layer',
      degradeReason: 'WSL1 does not support Linux namespaces required by bubblewrap; upgrade to WSL2 for OS-level sandboxing',
    };
  }

  if (platform === 'windows') {
    return detectWindowsBackend();
  }

  return { backend: 'app-layer' };
}

function detectBwrap(
  executable: string,
  extraArgs: string[] | undefined,
  degradeReason: string,
): DetectResult {
  const probe = extraArgs
    ? spawnSync(executable, [...extraArgs, 'bwrap', '--version'], { encoding: 'utf8', timeout: 8_000 })
    : spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5_000 });

  if (probe.status === 0) return { backend: 'bubblewrap' };
  return { backend: 'app-layer', degradeReason };
}

function detectWindowsBackend(): DetectResult {
  // Try wsl.exe — if present and WSL2 is default, we can use bwrap inside it
  const wslStatus = spawnSync('wsl.exe', ['--status'], { encoding: 'utf8', timeout: 8_000 });

  if (wslStatus.status !== 0) {
    return {
      backend: 'app-layer',
      degradeReason: 'WSL not found; install WSL2 (wsl --install) and bubblewrap for OS-level sandboxing',
    };
  }

  // WSL is installed — check for bwrap inside it
  return detectBwrap(
    'wsl.exe',
    ['bash', '-c'],
    'WSL found but bubblewrap not installed; run `wsl -- apt install bubblewrap` for OS-level sandboxing',
  );
}

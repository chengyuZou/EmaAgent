import { readFileSync } from 'node:fs';

// ── Platform type ─────────────────────────────────────────────────────────────

export type SandboxPlatform = 'windows' | 'wsl1' | 'wsl2' | 'linux' | 'macos';

let cached: SandboxPlatform | undefined;

export function getPlatform(): SandboxPlatform {
  if (cached) return cached;
  cached = detect();
  return cached;
}

/** Clear cached platform — only for tests. */
export function resetPlatformCache(): void {
  cached = undefined;
}

function detect(): SandboxPlatform {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';

  // Linux — could be native or WSL
  try {
    const release = readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase();
    if (release.includes('microsoft')) {
      // WSL2 kernel versions include "wsl2" in the release string
      return release.includes('wsl2') ? 'wsl2' : 'wsl1';
    }
  } catch {
    // Non-Linux or /proc not mounted — treat as linux
  }

  return 'linux';
}

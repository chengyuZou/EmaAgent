import fs from 'node:fs';
import type { Platform } from './types.js';

let _platform: Platform | undefined;

/**
 * Returns the current runtime platform, including WSL detection.
 * Result is cached after the first call.
 *
 * WSL is detected by reading /proc/sys/kernel/osrelease (same source as
 * sandbox/platform.ts) — on WSL1 and WSL2 the string contains "microsoft".
 * We treat both WSL1 and WSL2 as 'wsl' here because NTFS Alternate Data
 * Streams are interpreted by the Windows kernel even from WSL (DrvFs mounts),
 * so Windows-specific path checks must run on both.
 *
 * (sandbox/platform.ts additionally distinguishes wsl1 vs wsl2 for backend
 * selection; that finer grain isn't needed for permission path checking.)
 */
export function getPlatform(): Platform {
  if (_platform !== undefined) return _platform;

  if (process.platform === 'win32') return (_platform = 'windows');
  if (process.platform === 'darwin') return (_platform = 'macos');

  try {
    const release = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase();
    if (release.includes('microsoft')) return (_platform = 'wsl');
  } catch {
    // Not WSL or /proc not mounted — treat as Linux
  }

  return (_platform = 'linux');
}

/** Reset cached platform (test helper). */
export function resetPlatformCache(): void {
  _platform = undefined;
}

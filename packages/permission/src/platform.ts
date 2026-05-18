import fs from 'node:fs';
import type { Platform } from './types.js';

let _platform: Platform | undefined;

/**
 * Returns the current runtime platform, including WSL detection.
 * Result is cached after the first call.
 *
 * WSL is detected by reading /proc/version — on WSL1 and WSL2 this file
 * contains "Microsoft" or "WSL". We treat WSL as its own platform because
 * NTFS Alternate Data Streams are interpreted by the Windows kernel even
 * when accessed from WSL (via DrvFs mounts), so Windows-specific path checks
 * must still run there.
 */
export function getPlatform(): Platform {
  if (_platform !== undefined) return _platform;

  if (process.platform === 'win32') return (_platform = 'windows');
  if (process.platform === 'darwin') return (_platform = 'macos');

  try {
    const version = fs.readFileSync('/proc/version', 'utf8');
    if (/microsoft|wsl/i.test(version)) return (_platform = 'wsl');
  } catch {
    // Not WSL or /proc not available — treat as Linux
  }

  return (_platform = 'linux');
}

/** Reset cached platform (test helper). */
export function resetPlatformCache(): void {
  _platform = undefined;
}

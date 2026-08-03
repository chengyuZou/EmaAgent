// 识别 Permission 路径检查需要的平台差异，并统一跨平台比较格式。

import fs from 'node:fs';
import type { Platform } from '../types.js';

let cachedPlatform: Platform | undefined;

/**
 * WSL1 与 WSL2 都归为 wsl，因为 DrvFs 上的 NTFS ADS 仍由 Windows 内核解释，
 * Permission 必须继续执行 Windows 路径检查。Sandbox 选择后端时才需要区分 WSL 版本。
 */
export function getPlatform(): Platform {
  if (cachedPlatform !== undefined) return cachedPlatform;

  if (process.platform === 'win32') return (cachedPlatform = 'windows');
  if (process.platform === 'darwin') return (cachedPlatform = 'macos');

  try {
    const release = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase();
    if (release.includes('microsoft')) return (cachedPlatform = 'wsl');
  } catch {
    // /proc 不存在或不可读时按普通 Linux 处理。
  }

  return (cachedPlatform = 'linux');
}

/** 把平台原生分隔符转换为规则匹配统一使用的 POSIX 形式。 */
export function toPortablePath(candidate: string): string {
  return getPlatform() === 'windows' ? candidate.replace(/\\/g, '/') : candidate;
}

/** 测试切换运行平台后清除缓存。 */
export function resetPlatformCache(): void {
  cachedPlatform = undefined;
}

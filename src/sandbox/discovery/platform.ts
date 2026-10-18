import { readFileSync } from 'node:fs';

/**
 * 当前 Node 进程的运行环境. Windows 进程即使能调用 WSL 仍返回 windows;
 * 进程本身运行在 WSL 内时才区分 wsl1/wsl2. 可用后端由 detectBackend 另行检测.
 */
export type SandboxPlatform = 'windows' | 'wsl1' | 'wsl2' | 'linux' | 'macos';

let cached: SandboxPlatform | undefined;

/**
 * 探测当前运行平台, 含 WSL1/WSL2 区分.
 * 结果在进程生命周期内缓存; 测试用 resetPlatformCache() 强制重探.
 */
export function getPlatform(): SandboxPlatform {
  if (cached) return cached;
  cached = detectPlatform();
  return cached;
}

/** 清空平台探测缓存, 仅供测试使用. */
export function resetPlatformCache(): void {
  cached = undefined;
}

function detectPlatform(): SandboxPlatform {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';

  // Linux 系(含 WSL1/WSL2, process.platform 均为 'linux')读内核 release 区分.
  try {
    const release = readFileSync('/proc/sys/kernel/osrelease', 'utf8');
    return classifyLinuxRelease(release);
  } catch {
    // 未读取到内核版本时按 Linux 处理, 后端启动失败仍会降级.
    return 'linux';
  }
}

/** 依赖内核 release 的 microsoft/wsl2 子串, 定制内核名称可能导致误判. */
export function classifyLinuxRelease(release: string): 'linux' | 'wsl1' | 'wsl2' {
  const lower = release.toLowerCase();
  if (!lower.includes('microsoft')) return 'linux';
  return lower.includes('wsl2') ? 'wsl2' : 'wsl1';
}

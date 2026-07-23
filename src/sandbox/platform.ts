import { readFileSync } from 'node:fs';

// ── Platform type ─────────────────────────────────────────────────────────────

export type SandboxPlatform = 'windows' | 'wsl1' | 'wsl2' | 'linux' | 'macos';

let cached: SandboxPlatform | undefined;

/**
 * 探测当前运行平台，含 WSL1/WSL2 区分。
 * 结果在进程生命周期内缓存。传 `{ fresh: true }` 可强制重探。
 */
export function getPlatform(opts?: { fresh?: boolean }): SandboxPlatform {
  if (!opts?.fresh && cached) return cached;
  cached = detect();
  return cached;
}

/** 清空平台探测缓存，仅供测试使用。 */
export function resetPlatformCache(): void {
  cached = undefined;
}

function detect(): SandboxPlatform {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';

  // Linux 可能是原生或 WSL。读 /proc/sys/kernel/osrelease 区分。
  try {
    const release = readFileSync('/proc/sys/kernel/osrelease', 'utf8');
    return classifyLinuxRelease(release);
  } catch {
    // 非 Linux 或 /proc 未挂载（某些容器环境），按 Linux 处理。
    return 'linux';
  }
}

/**
 * 根据 Linux 内核 release 字符串判断是原生 Linux 还是 WSL1/WSL2。纯函数，可单测。
 *
 * 判断依据（先转小写再匹配）：
 *   - 含 "microsoft" 且含 "wsl2" -> wsl2（release 形如 5.15.x-microsoft-standard-WSL2）
 *   - 含 "microsoft" 但不含 "wsl2" -> wsl1（release 形如 4.4.0-17763-Microsoft）
 *   - 其余 -> linux
 *
 * 已知局限：依赖 "wsl2" 子串。若微软未来改命名（如 wsl3 或去掉后缀），
 * WSL2 会被误判为 WSL1。这是 codex 等同类工具的共同做法，暂无更稳的纯字符串判据；
 * 更可靠的 /proc/sys/fs/binfmt_misc 或 /run/WSL 目录检测代价较高，V1 不引入。
 */
export function classifyLinuxRelease(release: string): 'linux' | 'wsl1' | 'wsl2' {
  const lower = release.toLowerCase();
  if (!lower.includes('microsoft')) return 'linux';
  return lower.includes('wsl2') ? 'wsl2' : 'wsl1';
}

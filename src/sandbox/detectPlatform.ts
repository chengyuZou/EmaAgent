import { readFileSync } from 'node:fs';

// ── Platform type ─────────────────────────────────────────────────────────────

/**
 * 当前 Node 进程运行在哪个环境，只表达"我在哪"，不表达"能用哪个沙箱后端"。
 *
 * 'windows' | 'macos' 是宿主 OS；'linux' | 'wsl1' | 'wsl2' 是进程运行环境：
 * 仅当进程自身跑在 WSL 内部时才会得到 wsl1/wsl2（此时 process.platform 是
 * 'linux'，只能读 /proc 区分）。Windows 宿主想借 WSL2 跑 bwrap 的场景拿到的
 * 仍是 'windows'，wsl.exe 与 bwrap 是否可用由 detectBackend 另行探测。
 * 由环境到后端的映射与真实冒烟见 detectBackend.ts。
 */
export type SandboxPlatform = 'windows' | 'wsl1' | 'wsl2' | 'linux' | 'macos';

let cached: SandboxPlatform | undefined;

/**
 * 探测当前运行平台，含 WSL1/WSL2 区分。
 * 结果在进程生命周期内缓存；测试用 resetPlatformCache() 强制重探。
 */
export function getPlatform(): SandboxPlatform {
  if (cached) return cached;
  cached = detectPlatform();
  return cached;
}

/** 清空平台探测缓存，仅供测试使用。 */
export function resetPlatformCache(): void {
  cached = undefined;
}

function detectPlatform(): SandboxPlatform {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';

  // Linux 系（含 WSL1/WSL2，process.platform 均为 'linux'）读内核 release 区分。
  try {
    const release = readFileSync('/proc/sys/kernel/osrelease', 'utf8');
    return classifyLinuxRelease(release);
  } catch {
    // 走到这里只可能是 Linux 系但读不到 osrelease（如未挂 /proc 的容器）。
    // 按原生 Linux 上报；若 bwrap 实际不可用，detectBackend 冒烟会如实降级。
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

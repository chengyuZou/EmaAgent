import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getPlatform } from './platform.js';
import { WSL_BASH_SENTINEL } from './types.js';

export type ShellProbeResult =
  | { available: true;  path: string }
  | { available: false; wingetAvailable: boolean; wslAvailable: boolean };

export interface GitInstallResult {
  ok:  boolean;
  log: string;
}


/** 从 git.exe 所在路径反推同安装根下的 bash.exe。 */
function gitBashFromGitExecutable(): string | null {
  // `where git` 比 `where bash` 更可能命中：Git 安装器默认把 git.exe 加进 PATH，
  // 但用户可能选了“只加 git 到 PATH”而不加 bash。此时 git 在 PATH、bash 不在。
  // git.exe 通常在 <GitRoot>\cmd\git.exe 或 <GitRoot>\bin\git.exe，
  // bash.exe 固定在 <GitRoot>\usr\bin\bash.exe。
  let whereGit: { status: number | null; stdout: string };
  try {
    whereGit = spawnSync('where', ['git'], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  if (whereGit.status !== 0 || !whereGit.stdout.trim()) return null;

  for (const rawLine of whereGit.stdout.trim().split(/\r?\n/)) {
    const gitExe = rawLine.trim();
    if (!gitExe) continue;
    // 逐级上溯找到 Git 根目录（含 usr\bin 的那一层）。
    let dir = gitExe;
    for (let i = 0; i < 4; i += 1) {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
      const candidate = join(dir, 'usr', 'bin', 'bash.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** 从注册表读取 Git 安装路径（HKLM 或 HKCU），返回 bash.exe 路径或 null。 */
function gitBashFromRegistry(): string | null {
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const r = spawnSync(
        'reg', ['query', `${hive}\\SOFTWARE\\GitForWindows`, '/v', 'InstallPath'],
        { encoding: 'utf8', timeout: 3_000, windowsHide: true },
      );
      if (r.status === 0) {
        const m = r.stdout.match(/InstallPath\s+REG_SZ\s+(.+)/);
        if (m) {
          const candidate = `${m[1]!.trim()}\\usr\\bin\\bash.exe`;
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch { /* 注册表查询失败时忽略，继续尝试下一个 hive */ }
  }
  return null;
}

/**
 * 确认 WSL 有可用的 bash：已安装发行版且能在其中运行 `bash`。
 * `wsl --status` 返回 0 只代表 wsl.exe 存在（可能没装发行版），
 * 所以要实际调用 bash。在超时内退出码 0 即视为可用。
 */
function probeWslBash(): boolean {
  const r = spawnSync('wsl.exe', ['bash', '-c', 'echo ok'], {
    encoding:    'utf8',
    timeout:     8_000,
    windowsHide: true,
  });
  return r.status === 0;
}

let cached: ShellProbeResult | undefined;

/**
 * 探测当前平台的 bash 可用性。
 * Linux / macOS 恒为 `{ available: true, path: '/bin/bash' }`。
 * Windows 按 PATH(`where bash`) -> git 反推 -> 注册表 -> WSL 顺序探测；
 * 全部失败时返回 winget/wsl 可用性，供前端引导安装。
 * 结果在进程生命周期内缓存；传 `{ fresh: true }` 可强制重探。
 */
export function probeShell(opts?: { fresh?: boolean }): ShellProbeResult {
  if (!opts?.fresh && cached !== undefined) return cached;

  const platform = getPlatform();
  if (platform !== 'windows') {
    return (cached = { available: true, path: '/bin/bash' });
  }

  const whereResult = spawnSync('where', ['bash'], {
    encoding:    'utf8',
    timeout:     3_000,
    windowsHide: true,
  });

  if (whereResult.status === 0 && whereResult.stdout.trim()) {
    const firstLine = whereResult.stdout.trim().split(/\r?\n/)[0]!.trim();
    return (cached = { available: true, path: firstLine });
  }

  // `where bash` 走的是进程继承的 PATH，刚装完 Git for Windows 但未重启进程时
  // 它仍会失败。改用不依赖 PATH 缓存的探测：从 `where git` 反推、再查注册表。
  // 这能覆盖非默认盘符（如 D:\Git）和绿色版安装，不再硬编码 Program Files 路径。
  const fallback = gitBashFromGitExecutable() ?? gitBashFromRegistry();
  if (fallback) {
    return (cached = { available: true, path: fallback });
  }

  // 没有 native bash.exe，但装了 WSL2 + 发行版也能用 bash。
  // `wsl --status` 返回 0 只证明 wsl.exe 存在（不代表装了发行版），
  // 所以要实际在 WSL 里调用 bash 验证。后端看到哨兵值时会走 `wsl.exe bash -c …`。
  if (probeWslBash()) {
    return (cached = { available: true, path: WSL_BASH_SENTINEL });
  }

  const wingetResult = spawnSync('winget', ['--version'], {
    encoding:    'utf8',
    timeout:     3_000,
    windowsHide: true,
  });

  const wslResult = spawnSync('wsl', ['--status'], {
    encoding:    'utf8',
    timeout:     3_000,
    windowsHide: true,
  });

  return (cached = {
    available:       false,
    wingetAvailable: wingetResult.status === 0,
    wslAvailable:    wslResult.status === 0,
  });
}

/**
 * 通过 winget 安装 Git for Windows（静默，per-user 无需 UAC）。
 * 成功后清空探测缓存，使下一次 `probeShell()` 重新探测。
 * 视下载速度约需 1-3 分钟。
 */
export function installGitViaWinget(): Promise<GitInstallResult> {
  return new Promise((resolve) => {
    const proc = spawn(
      'winget',
      [
        'install', '--id', 'Git.Git',
        '-e', '--source', 'winget',
        '--scope', 'user',
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
      ],
      { windowsHide: true },
    );

    const chunks: string[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, log: '安装超时（5 分钟），请手动下载安装。' });
    }, 300_000);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      const ok = code === 0;
      if (ok) {
        // winget 装完后，父进程的 PATH 缓存还没更新，`where bash` 仍会失败。
        // 改用不依赖 PATH 的探测：从 `where git` 反推、再查注册表。
        // 注册表是 winget/标准安装都会写的权威源，比硬编码路径可靠。
        const found = gitBashFromGitExecutable() ?? gitBashFromRegistry();
        cached = found
          ? { available: true, path: found }
          : undefined; // 没找到就清缓存，下次 probeShell() 重新全链路探测
      }
      resolve({ ok, log: chunks.join('').trim() });
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, log: err.message });
    });
  });
}

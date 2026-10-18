import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getPlatform } from './platform.js';

/** native 提供本机 Bash 路径; wsl 通过 wsl.exe 启动, 没有本机 Bash 路径. */
export type BashProbeResult =
  | { readonly available: true; readonly source: 'native'; readonly path: string }
  | { readonly available: true; readonly source: 'wsl' }
  | { readonly available: false };

interface CaptureResult {
  readonly status: number | null;
  readonly stdout: string;
}

/** 探测超时或启动失败时返回 status: null, 让调用方继续尝试其他位置. */
export function runCapture(executable: string, args: readonly string[], timeoutMs: number): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], { windowsHide: true });
    let stdout = '';
    let settled = false;
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 进程已退出.
      }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

/**
 * 从 git.exe 所在路径反推同安装根下的 bash.exe.
 * `where git` 比 `where bash` 更可能命中: Git 安装器默认把 git.exe 加进 PATH,
 * 但用户可能选了"只加 git 到 PATH"而不加 bash.
 */
async function gitBashFromGitExecutable(): Promise<string | null> {
  const whereGit = await runCapture('where', ['git'], 3_000);
  if (whereGit.status !== 0 || !whereGit.stdout.trim()) return null;

  for (const rawLine of whereGit.stdout.trim().split(/\r?\n/)) {
    const gitExe = rawLine.trim();
    if (!gitExe) continue;
    // 逐级上溯找到 Git 根目录(含 usr\bin 的那一层).
    // 最多向上检查四层, 覆盖 cmd/git.exe 和 mingw64/bin/git.exe 等常见布局.
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

/** 从注册表读取 Git 安装路径(HKLM 或 HKCU), 返回 bash.exe 路径或 null. */
async function gitBashFromRegistry(): Promise<string | null> {
  for (const hive of ['HKLM', 'HKCU']) {
    const r = await runCapture(
      'reg', ['query', `${hive}\\SOFTWARE\\GitForWindows`, '/v', 'InstallPath'],
      3_000,
    );
    if (r.status === 0) {
      const m = r.stdout.match(/InstallPath\s+REG_SZ\s+(.+)/);
      if (m) {
        const candidate = `${m[1]!.trim()}\\usr\\bin\\bash.exe`;
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * 在默认 WSL 发行版中实际运行 Bash, 而不只检查 wsl.exe 是否存在.
 * 冷启动可能较慢, 此项允许等待 16 秒.
 */
async function probeWslBash(): Promise<boolean> {
  const r = await runCapture('wsl.exe', ['bash', '-c', 'echo ok'], 16_000);
  return r.status === 0;
}

/**
 * 依次检查 PATH, Git 安装目录, 注册表和 WSL, 找到后立即返回.
 * 顺序执行可以避免本机已有 Bash 时仍启动 WSL.
 */
async function probeWindowsBash(): Promise<BashProbeResult> {
  const whereBash = await runCapture('where', ['bash'], 3_000);
  if (whereBash.status === 0 && whereBash.stdout.trim()) {
    const firstLine = whereBash.stdout.trim().split(/\r?\n/)[0]!.trim();
    return { available: true, source: 'native', path: firstLine };
  }

  // `where bash` 走进程继承的 PATH, 刚装完 Git 未重启进程时仍会失败;
  // 注册表检查不依赖当前进程的 PATH, 可以发现启动进程后才安装的 Git.
  const fallback = (await gitBashFromGitExecutable()) ?? (await gitBashFromRegistry());
  if (fallback) return { available: true, source: 'native', path: fallback };

  // 本机没有找到 Bash 时, 再尝试通过 WSL 启动.
  if (await probeWslBash()) return { available: true, source: 'wsl' };

  return { available: false };
}

let cachedProbe: Promise<BashProbeResult> | undefined;

function runProbe(): Promise<BashProbeResult> {
  const promise: Promise<BashProbeResult> = getPlatform() === 'windows'
    ? probeWindowsBash()
    // 非 Windows 分支使用约定的 /bin/bash 路径, 不在这里验证文件是否存在或能否启动.
    : Promise.resolve({ available: true, source: 'native', path: '/bin/bash' });
  cachedProbe = promise;
  return promise;
}

/**
 * 并发调用共享一次探测. Server 提前发起探测, 传 { fresh: true } 时重新查找.
 */
export function probeBash(options?: { fresh?: boolean }): Promise<BashProbeResult> {
  if (!options?.fresh && cachedProbe !== undefined) return cachedProbe;
  return runProbe();
}

/** 清空探测结果及正在等待的 Promise 引用. 不会取消已经启动的探测进程. */
export function resetBashProbeCache(): void {
  cachedProbe = undefined;
}

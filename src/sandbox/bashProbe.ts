// 探测当前平台的 bash 可用性(本模块只探测 bash, 不是泛指 shell)。
// 异步探测链: where bash → git 反推 → 注册表 → WSL,回退顺序即"便宜到贵"。
// 结果按 Promise 缓存: Server 启动预热后,同步执行路径经 probeBashSettled 零成本命中。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getPlatform } from './detectPlatform.js';

/**
 * bash 探测结果。available 时分两种来源:
 * - native: 本机可执行文件, path 是真实文件路径;
 * - wsl:    bash 在 WSL 虚拟机内, 没有本机路径可言, 命令须经 wsl.exe 路由。
 * 不存在"可能是假路径的 path 字段"——消费方按 source 分支,不靠人肉记暗号。
 */
export type BashProbeResult =
  | { readonly available: true; readonly source: 'native'; readonly path: string }
  | { readonly available: true; readonly source: 'wsl' }
  | { readonly available: false; readonly wingetAvailable: boolean; readonly wslAvailable: boolean };

// ── 异步执行辅助 ──────────────────────────────────────────────────────────────

interface CaptureResult {
  readonly status: number | null;
  readonly stdout: string;
}

/**
 * 带超时地执行一条探测命令并收集 stdout。
 * 超时/启动失败/被杀都按 { status: null } 返回, 不抛出——
 * 探测链的每一步都允许失败, 失败含义是"走下一级回退"。
 */
function runCapture(executable: string, args: readonly string[], timeoutMs: number): Promise<CaptureResult> {
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
      try { child.kill(); } catch { /* 进程已退出 */ }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

// ── Windows 回退链 ────────────────────────────────────────────────────────────

/**
 * 从 git.exe 所在路径反推同安装根下的 bash.exe。
 * `where git` 比 `where bash` 更可能命中: Git 安装器默认把 git.exe 加进 PATH,
 * 但用户可能选了"只加 git 到 PATH"而不加 bash。
 */
async function gitBashFromGitExecutable(): Promise<string | null> {
  const whereGit = await runCapture('where', ['git'], 3_000);
  if (whereGit.status !== 0 || !whereGit.stdout.trim()) return null;

  for (const rawLine of whereGit.stdout.trim().split(/\r?\n/)) {
    const gitExe = rawLine.trim();
    if (!gitExe) continue;
    // 逐级上溯找到 Git 根目录（含 usr\bin 的那一层）。
    // 4 层足够：git.exe 最深在 <GitRoot>\mingw64\bin\git.exe（3 层到根），
    // cmd\git.exe 和 bin\git.exe 都在 2 层内。portablegit 解压目录同理。
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
 * 确认 WSL 有可用的 bash：已安装发行版且能在其中运行 `bash`。
 * `wsl --status` 返回 0 只代表 wsl.exe 存在（可能没装发行版），
 * 所以要实际调用 bash。WSL2 首次冷启动可能数秒, 超时放宽到 16 秒。
 */
async function probeWslBash(): Promise<boolean> {
  const r = await runCapture('wsl.exe', ['bash', '-c', 'echo ok'], 16_000);
  return r.status === 0;
}

/**
 * Windows 探测链。顺序即"便宜到贵", 命中即停:
 * PATH(where bash, 毫秒级) → git 反推 → 注册表 → WSL(可能冷启动数秒)。
 * 不要并发化整条链——在 PATH 就有 bash 的机器上白白冷启动 WSL 是纯浪费。
 */
async function probeWindowsBash(): Promise<BashProbeResult> {
  const whereBash = await runCapture('where', ['bash'], 3_000);
  if (whereBash.status === 0 && whereBash.stdout.trim()) {
    const firstLine = whereBash.stdout.trim().split(/\r?\n/)[0]!.trim();
    return { available: true, source: 'native', path: firstLine };
  }

  // `where bash` 走进程继承的 PATH, 刚装完 Git 未重启进程时仍会失败;
  // 改用不依赖 PATH 缓存的探测: git 反推、注册表。
  const fallback = (await gitBashFromGitExecutable()) ?? (await gitBashFromRegistry());
  if (fallback) return { available: true, source: 'native', path: fallback };

  // 没有 native bash.exe, 但装了 WSL + 发行版也能用 bash(经 wsl.exe 路由)。
  if (await probeWslBash()) return { available: true, source: 'wsl' };

  // 全部失败: 报告 winget/wsl 可用性供前端引导。两项互相独立, 并行。
  const [winget, wsl] = await Promise.all([
    runCapture('winget', ['--version'], 3_000),
    runCapture('wsl', ['--status'], 3_000),
  ]);
  return {
    available: false,
    wingetAvailable: winget.status === 0,
    wslAvailable: wsl.status === 0,
  };
}

// ── 缓存与公共入口 ────────────────────────────────────────────────────────────

const probeCache = {
  promise: undefined as Promise<BashProbeResult> | undefined,
  settled: undefined as BashProbeResult | undefined,
};

function runProbe(): Promise<BashProbeResult> {
  const promise: Promise<BashProbeResult> = getPlatform() === 'windows'
    ? probeWindowsBash()
    // Linux/macOS 恒有 /bin/bash, 不发起任何子进程。
    : Promise.resolve({ available: true, source: 'native', path: '/bin/bash' });
  probeCache.promise = promise;
  probeCache.settled = undefined;
  // 只缓存"属于本次 promise"的结算; fresh 重探途中旧值不得污染。
  void promise.then((result) => {
    if (probeCache.promise === promise) probeCache.settled = result;
  });
  return promise;
}

/**
 * 探测当前平台的 bash 可用性。结果按 Promise 缓存, 并发调用共享同一次探测。
 * Server 启动时应 fire-and-forget 预热; 传 `{ fresh: true }` 强制重探。
 */
export function probeBash(opts?: { fresh?: boolean }): Promise<BashProbeResult> {
  if (!opts?.fresh && probeCache.promise !== undefined) return probeCache.promise;
  return runProbe();

}

/**
 * 同步读取已结算的探测结果; 尚未结算返回 undefined。
 * 仅供必须同步拿到 shell 的执行路径(CommandRunner.start);
 * 调用方必须把 undefined(探测窗口期)当正常情形如实报错, 不得假设命中。
 */
export function probeBashSettled(): BashProbeResult | undefined {
  return probeCache.settled;
}

/** 清空探测缓存; 供测试与 Git 安装完成后的强制重探使用。 */
export function resetBashProbeCache(): void {
  probeCache.promise = undefined;
  probeCache.settled = undefined;
}

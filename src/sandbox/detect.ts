import { spawnSync } from 'node:child_process';
import { getPlatform, type SandboxPlatform } from './platform.js';
import type { BackendKind, SandboxConfig } from './types.js';
import { buildBubblewrapCommand } from './backends/bubblewrap.js';
import { SandboxExecBackend } from './backends/sandbox-exec.js';

export type { BackendKind };

// ── Detection result ──────────────────────────────────────────────────────────

export interface DetectResult {
  backend: BackendKind
  /**
   * 当本该有 OS 级沙箱的平台却降级到 app-layer 时，给出人类可读的原因。
   * 在 Session 启动时通过 getSandboxUnavailableReason() 暴露给用户。
   */
  degradeReason?: string
}

let cached: DetectResult | undefined;

/**
 * 探测当前机器可用的沙箱后端。
 * 结果在进程生命周期内缓存(跨 Session 共享)。
 */
export function detectBackend(): DetectResult {
  if (cached) return cached;
  cached = runDetect();
  return cached;
}

/** 清空探测缓存，仅供测试使用。 */
export function resetDetectCache(): void {
  cached = undefined;
}

// ── 平台 -> 后端的纯映射（不触碰进程，可单测）────────────────────────────────

/**
 * 根据平台决定后端选择策略。纯函数，不执行任何 spawn，便于单测覆盖所有平台分支。
 * 返回值告诉 runDetect 该走哪条探测路径，以及失败时的降级原因。
 * 导出仅供测试；生产代码用 detectBackend()。
 */
export function selectBackendForPlatform(platform: SandboxPlatform):
  | { kind: 'sandbox-exec' }
  | { kind: 'bwrap-direct'; degradeReason: string }
  | { kind: 'bwrap-via-wsl'; degradeReason: string }
  | { kind: 'app-layer'; degradeReason: string } {

  switch (platform) {
    case 'macos':
      // sandbox-exec 是 macOS 系统内置（12+ 标记 deprecated 但仍可用）。
      return { kind: 'sandbox-exec' };

    case 'linux':
    case 'wsl2':
      // 原生 Linux 或 WSL2 都支持 Linux namespace，可直接调 bwrap。
      return {
        kind: 'bwrap-direct',
        degradeReason: 'bwrap not found; install bubblewrap (e.g. apt install bubblewrap) for OS-level sandboxing',
      };

    case 'wsl1':
      // WSL1 没有 Linux namespace，bwrap 无法运行，只能降级。
      return {
        kind: 'app-layer',
        degradeReason: 'WSL1 does not support Linux namespaces required by bubblewrap; upgrade to WSL2 for OS-level sandboxing',
      };

    case 'windows':
      // Windows 本身没有 bwrap，需探测 WSL2 + bwrap 组合，交给 detectWindowsBackend。
      return {
        kind: 'bwrap-via-wsl',
        degradeReason: 'WSL found but bubblewrap not installed; run `wsl -- apt install bubblewrap` for OS-level sandboxing',
      };
  }
}

// ── Detection logic ───────────────────────────────────────────────────────────

const SMOKE_MARKER = 'ema-sandbox-ok';

/** 冒烟配置: 贴近真实使用(断网 + 最小可写), 同时验证 namespace 与网络隔离生效。 */
function smokeConfig(): SandboxConfig {
  return {
    filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
    network: { access: 'none' },
  };
}

function runDetect(): DetectResult {
  const platform = getPlatform();
  const strategy = selectBackendForPlatform(platform);

  switch (strategy.kind) {
    case 'sandbox-exec':
      return smokeSandboxExec();

    case 'bwrap-direct':
      return smokeBwrap(platform, strategy.degradeReason);

    case 'bwrap-via-wsl':
      return detectWindowsBackend(strategy.degradeReason);

    case 'app-layer':
      return { backend: 'app-layer', degradeReason: strategy.degradeReason };
  }
}

/**
 * 真实启动自检: 二进制存在 ≠ namespace/系统策略允许隔离运行。
 * 走与生产一致的 wrap() 路径执行一条 echo, 输出不符即降级,
 * 避免向前端谎报 isolated 后第一条命令才失败。
 */
function smokeSandboxExec(): DetectResult {
  const wrapped = new SandboxExecBackend().wrap(`echo ${SMOKE_MARKER}`, '/bin/bash', smokeConfig());
  const probe = spawnSync(wrapped.executable, wrapped.args, {
    encoding: 'utf8',
    timeout: 8_000,
  });
  return probe.status === 0 && String(probe.stdout).includes(SMOKE_MARKER)
    ? { backend: 'sandbox-exec' }
    : {
        backend: 'app-layer',
        degradeReason:
          'sandbox-exec 无法实际执行隔离命令(系统策略拒绝或已移除), 已降级为应用层隔离',
      };
}

function smokeBwrap(platform: SandboxPlatform, degradeReason: string): DetectResult {
  const wrapped = buildBubblewrapCommand(`echo ${SMOKE_MARKER}`, '/bin/bash', smokeConfig(), platform);
  const probe = spawnSync(wrapped.executable, wrapped.args, {
    encoding: 'utf8',
    timeout: 8_000,
  });
  return probe.status === 0 && String(probe.stdout).includes(SMOKE_MARKER)
    ? { backend: 'bubblewrap' }
    : { backend: 'app-layer', degradeReason };
}

/**
 * Windows 后端探测：先确认 wsl.exe 存在，再在 WSL 内探测 bwrap。
 * @param wslBwrapMissingReason - WSL 存在但 bwrap 缺失时的降级原因
 */
function detectWindowsBackend(wslBwrapMissingReason: string): DetectResult {
  // 用 --list 而非 --status：--list 从首个公开 WSL 版本起就支持，
  // --status 是后加的，在部分旧构建上即使 WSL 可用也静默返回非 0。
  // 区分"二进制不存在"(ENOENT) 和"二进制存在但报错"。
  const wslList = spawnSync('wsl.exe', ['--list'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  const notFound = (wslList.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

  if (notFound) {
    return {
      backend: 'app-layer',
      degradeReason: 'WSL not found; install WSL2 (wsl --install) and bubblewrap for OS-level sandboxing',
    };
  }

  // wsl.exe 存在（即使 --list 返回非 0，比如还没装发行版）。
  // 继续在 WSL 内做真实 bwrap 冒烟，决定最终后端。
  return smokeBwrap('windows', wslBwrapMissingReason);
}

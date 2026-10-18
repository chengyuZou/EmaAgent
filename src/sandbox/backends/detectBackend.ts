import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { getPlatform, type SandboxPlatform } from '../discovery/platform.js';
import type { BackendKind, SandboxConfig } from '../types.js';
import { buildBubblewrapCommand } from './bubblewrap.js';
import { SandboxExecBackend } from './sandboxExec.js';

export interface DetectResult {
  readonly backend: BackendKind;
  /** 设置页默认展示的简短失败原因. */
  readonly degradeReason?: string;
  /** 正确解码的进程输出, 供设置页展开查看. */
  readonly degradeDetails?: string;
}

let cached: DetectResult | undefined;
const STARTUP_CHECK_MARKER = 'ema-sandbox-ok';

/** 结果在当前进程中共用. 自检只证明后端能启动, 不证明每项隔离规则都有效. */
export function detectBackend(): DetectResult {
  cached ??= runDetect();
  return cached;
}

export function resetDetectCache(): void {
  cached = undefined;
}

function startupCheckConfig(): SandboxConfig {
  return {
    filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
    network: { access: 'none' },
  };
}

function runDetect(): DetectResult {
  const platform = getPlatform();
  if (platform === 'wsl1') {
    return {
      backend: 'unisolated',
      degradeReason: 'WSL1 不支持 bubblewrap 所需的 Linux namespace, 请升级到 WSL2.',
    };
  }
  if (platform === 'windows') {
    const probe = spawnSync('wsl.exe', ['--list'], { timeout: 5_000, windowsHide: true });
    if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return {
        backend: 'unisolated',
        degradeReason: '未找到 WSL. 请安装 WSL2 与 bubblewrap 后重启 Server.',
      };
    }
    if (probe.status !== 0) {
      return failedProbe('WSL 环境', probe, true);
    }
  }
  return checkBackendStartup(platform);
}

function checkBackendStartup(platform: SandboxPlatform): DetectResult {
  const shell = { kind: 'native', path: '/bin/bash' } as const;
  const backend = platform === 'macos' ? 'sandbox-exec' : 'bubblewrap';
  const wrapped = platform === 'macos'
    ? new SandboxExecBackend().wrap(`echo ${STARTUP_CHECK_MARKER}`, shell, startupCheckConfig())
    : buildBubblewrapCommand(`echo ${STARTUP_CHECK_MARKER}`, shell, startupCheckConfig(), platform);
  const probe = spawnSync(wrapped.executable, wrapped.args, {
    timeout: 8_000,
    windowsHide: true,
  });
  const windowsLauncher = platform === 'windows';
  if (probe.status === 0 && decodeOutput(probe.stdout, windowsLauncher).includes(STARTUP_CHECK_MARKER)) {
    return { backend };
  }
  const label = platform === 'windows' ? 'WSL 中的 bubblewrap' : wrapped.executable;
  return failedProbe(label, probe, windowsLauncher);
}

function decodeOutput(output: Buffer | null, windowsLauncher: boolean): string {
  if (!output?.length) return '';
  // wsl.exe 自身的 Windows 提示可能是无 BOM 的 UTF-16LE, Linux 子进程仍可输出 UTF-8.
  // 先保留原始字节, 只在 Windows 输出含 BOM 或 UTF-16 的 NUL 字节时采用 UTF-16LE.
  const utf16 = windowsLauncher && (
    (output[0] === 0xff && output[1] === 0xfe) || output.includes(0)
  );
  return output.toString(utf16 ? 'utf16le' : 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r+\n/g, '\n')
    .trim();
}

function failedProbe(
  label: string,
  probe: SpawnSyncReturns<Buffer>,
  windowsLauncher: boolean,
): DetectResult {
  const output = [
    probe.error?.message,
    decodeOutput(probe.stderr, windowsLauncher),
    decodeOutput(probe.stdout, windowsLauncher),
  ].filter(Boolean).join('\n\n');
  let details = output;
  if (!details) {
    if (probe.status === 0) {
      details = `命令未返回预期标记 ${STARTUP_CHECK_MARKER}.`;
    } else if (probe.signal) {
      details = `进程收到 ${probe.signal}.`;
    } else {
      details = `退出码 ${probe.status ?? 'unknown'}.`;
    }
  }
  return {
    backend: 'unisolated',
    degradeReason: `${label} 启动检查未通过.`,
    degradeDetails: details,
  };
}

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { getPlatform, type SandboxPlatform } from '../discovery/platform.js';
import type { BackendKind, SandboxConfig } from '../types.js';
import { buildBubblewrapCommand } from './bubblewrap.js';
import { SandboxExecBackend } from './sandboxExec.js';

export interface DetectResult {
  readonly backend: BackendKind;
  /** 启动自检失败的实际原因, 供 Server 在设置页展示. */
  readonly degradeReason?: string;
}

let cached: DetectResult | undefined;
const SMOKE_MARKER = 'ema-sandbox-ok';

/** 结果在当前进程中共用. 自检只证明后端能启动, 不证明每项隔离规则都有效. */
export function detectBackend(): DetectResult {
  cached ??= runDetect();
  return cached;
}

export function resetDetectCache(): void {
  cached = undefined;
}

function smokeConfig(): SandboxConfig {
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
    const probe = spawnSync('wsl.exe', ['--list'], { encoding: 'utf8', timeout: 5_000 });
    if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return {
        backend: 'unisolated',
        degradeReason: '未找到 WSL. 请安装 WSL2 与 bubblewrap 后重启 Server.',
      };
    }
    // wsl.exe 存在不代表有可用发行版, 其余失败交给实际命令报告.
  }
  return smokeBackend(platform);
}

function smokeBackend(platform: SandboxPlatform): DetectResult {
  const shell = { kind: 'native', path: '/bin/bash' } as const;
  const backend = platform === 'macos' ? 'sandbox-exec' : 'bubblewrap';
  const wrapped = platform === 'macos'
    ? new SandboxExecBackend().wrap(`echo ${SMOKE_MARKER}`, shell, smokeConfig())
    : buildBubblewrapCommand(`echo ${SMOKE_MARKER}`, shell, smokeConfig(), platform);
  const probe = spawnSync(wrapped.executable, wrapped.args, {
    encoding: 'utf8',
    timeout: 8_000,
  });
  if (probe.status === 0 && probe.stdout.includes(SMOKE_MARKER)) {
    return { backend };
  }
  const label = platform === 'windows' ? 'WSL 中的 bubblewrap' : wrapped.executable;
  return {
    backend: 'unisolated',
    degradeReason: `${label} 启动检查失败: ${probeFailure(probe)}`,
  };
}

function probeFailure(probe: SpawnSyncReturns<string>): string {
  const details = [probe.error?.message, probe.stderr?.trim()].filter(Boolean).join(' ');
  if (details) return details;
  if (probe.status === 0) return `命令未返回预期标记 ${SMOKE_MARKER}.`;
  if (probe.stdout?.trim()) return probe.stdout.trim();
  if (probe.signal) return `进程收到 ${probe.signal}.`;
  return `退出码 ${probe.status ?? 'unknown'}.`;
}

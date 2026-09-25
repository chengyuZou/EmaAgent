// 系统只读状态：健康探针（无认证）、版本、磁盘与数据目录、沙箱隔离等级。
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { getDisksInfo } from '@ema-agent/system';
import { detectTerminalShells, type SandboxStatus } from '@ema-agent/sandbox';

export interface SystemStatusRouteDeps {
  readonly activeDataDir: string;
  readonly getSandboxStatus: () => SandboxStatus;
}

/** 包版本在模块加载时读一次；运行期不变。 */
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export const systemStatusRoute = (deps: SystemStatusRouteDeps) =>
  new Hono()
    // 探活: 宿主可用已公布的端口访问, 无需认证.
    .get('/health', context => {
      return context.json({ ok: true, service: 'server' });
    })
    .get('/version', context => {
      return context.json({ version: SERVER_VERSION });
    })
    .get('/disks', context => {
      return context.json({ disks: getDisksInfo(), dataDir: deps.activeDataDir });
    })
    // 当前机器真正启用的隔离等级（裸 Windows 无 OS 沙箱时如实降级）。
    .get('/sandbox', context => context.json(deps.getSandboxStatus()))
    // 集成终端可选 Shell 探测（检测统一在 Node；Rust 只按 path 起 PTY）。
    .get('/api/system/find-terminal-shells', async context => {
      return context.json({ shells: await detectTerminalShells() });
    });

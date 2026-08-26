// 系统只读状态：健康探针（无认证）、版本、磁盘与数据目录、沙箱隔离等级。
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { getDisksInfo } from '@ema-agent/system';
import type { SandboxStatus } from '@ema-agent/sandbox';

export interface SystemStatusRouteDeps {
  readonly activeDataDir: string;
  readonly sandboxStatus: SandboxStatus;
}

/** 包版本在模块加载时读一次；运行期不变。 */
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export const systemStatusRoute = (deps: SystemStatusRouteDeps) =>
  new Hono()
    // 探活：readiness 文件发布前宿主轮询；无需认证。
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
    .get('/sandbox', context => context.json(deps.sandboxStatus));

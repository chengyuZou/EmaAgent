import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { getDisksInfo } from '@ema-agent/system';
import { detectTerminalShells } from '@ema-agent/sandbox';
import type { SandboxStatus } from '../../composition/tools.js';

export interface SystemStatusRouteDeps {
  readonly activeDataDir: string;
  readonly getSandboxStatus: () => SandboxStatus;
}

/** 包版本在模块加载时读一次, 运行期不变. */
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
    // Server 将后端探测与 Bash 启用策略组合, 前端不重新推断这些状态.
    .get('/sandbox', context => context.json(deps.getSandboxStatus()))
    // Node 查找可选 Shell, Rust 根据返回的 path 启动 PTY.
    .get('/api/system/find-terminal-shells', async context => {
      return context.json({ shells: await detectTerminalShells() });
    });

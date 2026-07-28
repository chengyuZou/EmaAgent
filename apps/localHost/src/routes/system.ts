// 提供磁盘和沙箱安全状态等只读系统接口。

import { Hono } from 'hono';
import { getDisksInfo } from '@ema-agent/system';
import type { SandboxStatusWire } from '@ema-agent/sandbox';

export function systemRoute(
  activeDataDir: string,
  sandboxStatus: SandboxStatusWire,
): Hono {
  const app = new Hono();

  // GET /api/system/disks - 磁盘信息 + 当前 dataDir
  app.get('/disks', (c) => {
    return c.json({
      disks:   getDisksInfo(),
      dataDir: activeDataDir,
    });
  });

  // GET /api/system/sandbox - 当前机器真正启用的隔离等级。
  app.get('/sandbox', (c) => c.json(sandboxStatus));

  return app;
}

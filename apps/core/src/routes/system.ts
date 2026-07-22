// 这里提供磁盘、发布能力和沙箱安全状态等只读系统接口。

import { Hono } from 'hono';
import { getDisksInfo } from '@ema-agent/system';
import type { AppCapabilitiesWire } from '@ema-agent/system';
import type { AppBindings } from '../wiring/index.js';

export function systemRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // GET /api/system/disks — 磁盘信息 + 当前 dataDir
  app.get('/disks', (c) => {
    return c.json({
      disks:   getDisksInfo(),
      dataDir: bindings.activeDataDir,
    });
  });

  // GET /api/system/capabilities — V1 发布特性开关
  // 前端据此决定是否显示 Artifact 等未完成功能入口(fail-closed)。
  app.get('/capabilities', (c) => {
    const body: AppCapabilitiesWire = {
      release: 'v1',
      features: bindings.releaseFeatures,
    };
    return c.json(body);
  });

  // GET /api/system/sandbox — 当前机器真正启用的隔离等级。
  app.get('/sandbox', (c) => c.json(bindings.sandboxStatus));

  return app;
}

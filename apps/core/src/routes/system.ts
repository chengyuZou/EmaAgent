import { Hono } from 'hono';
import { getDisksInfo } from '@ema-agent/system';
import type { AppCapabilitiesWire } from '@ema-agent/contracts';
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

  return app;
}

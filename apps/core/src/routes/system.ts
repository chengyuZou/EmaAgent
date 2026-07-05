import { Hono } from 'hono';
import { getDisksInfo } from '@ema-agent/system';
import type { AppBindings } from '../wiring/index.js';

export function systemRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // GET /api/system/disks — disk info + active dataDir
  app.get('/disks', (c) => {
    return c.json({
      disks:   getDisksInfo(),
      dataDir: bindings.activeDataDir,
    });
  });

  return app;
}

// 记忆存储占用统计：实测字节、上限与分级（normal/warning/limitExceeded）。
import { Hono } from 'hono';
import {
  evaluateMemoryStorage,
  measureMemoryStorageBytes,
  readMemoryStorageLimit,
} from '@ema-agent/memory';
import type { SettingsStore } from '@ema-agent/settings';

export interface MemoryStatsRouteDeps {
  readonly memoryRoot: string;
  readonly settings: Pick<SettingsStore, 'get'>;
}

export function memoryStatsRoute(deps: MemoryStatsRouteDeps): Hono {
  const app = new Hono();

  app.get('/stats', async context => {
    const limit = readMemoryStorageLimit(deps.settings as SettingsStore);
    const usedBytes = await measureMemoryStorageBytes(deps.memoryRoot);
    return context.json({
      usedBytes,
      limit,
      status: evaluateMemoryStorage(usedBytes, limit),
    });
  });

  return app;
}

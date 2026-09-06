import { promises as fs } from 'node:fs';
import { Hono } from 'hono';
import {
  evaluateMemoryCapacity,
  measureMemoryStorageBytes,
} from '@ema-agent/memory';

export interface MemoryStatsRouteDeps {
  readonly memoryRoot: string;
}

export const memoryStatsRoute = (deps: MemoryStatsRouteDeps) =>
  new Hono().get('/stats', async context => {
    await fs.mkdir(deps.memoryRoot, { recursive: true });
    const usedBytes = await measureMemoryStorageBytes(deps.memoryRoot);
    return context.json({
      ...evaluateMemoryCapacity(usedBytes),
      rootPath: deps.memoryRoot,
    });
  });

// 记忆维护操作：手动整合、清除与存储清理的触发口；全部走 Job 入队 + 执行器单飞。
import { Hono } from 'hono';
import { z } from 'zod';
import type { ConsolidationKind, MaintenanceKind } from '@ema-agent/memory';

export interface MemoryOpsRouteDeps {
  readonly startConsolidation: (kind: ConsolidationKind) => void;
  readonly startMaintenance: (kind: MaintenanceKind) => void;
}

const consolidateBody = z.object({
  kind: z.enum(['work_consolidation', 'relationship_consolidation']),
});

const maintenanceBody = z.object({
  kind: z.enum(['clear_memory', 'storage_cleanup']),
});

export function memoryOpsRoute(deps: MemoryOpsRouteDeps): Hono {
  const app = new Hono();

  // 手动整合一条轨：入队整合 Job 并立即认领（冷却期内执行器不认领）。
  app.post('/consolidate', async context => {
    const parsed = consolidateBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    deps.startConsolidation(parsed.data.kind);
    return context.json({ ok: true }, 202);
  });

  // 维护操作：clear_memory 按登记的 paths 清除（空 = 全部）；storage_cleanup 按上限清理。
  app.post('/maintenance', async context => {
    const parsed = maintenanceBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    deps.startMaintenance(parsed.data.kind);
    return context.json({ ok: true }, 202);
  });

  return app;
}

// 记忆维护操作：手动整合、清除与存储清理的触发口；全部走 Job 入队 + 执行器单飞。
import { Hono } from 'hono';
import { z } from 'zod';
import type { ConsolidationKind, MaintenanceKind } from '@ema-agent/memory';
import { jsonBody } from '../validate.js';

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

export const memoryOpsRoute = (deps: MemoryOpsRouteDeps) =>
  new Hono()
    // 手动整合一条轨：入队整合 Job 并立即认领（冷却期内执行器不认领）。
    .post('/consolidate', jsonBody(consolidateBody), async context => {
      const { kind } = context.req.valid('json');
      deps.startConsolidation(kind);
      return context.json({ ok: true }, 202);
    })
    // 维护操作：clear_memory 按登记的 paths 清除（空 = 全部）；storage_cleanup 按上限清理。
    .post('/maintenance', jsonBody(maintenanceBody), async context => {
      const { kind } = context.req.valid('json');
      deps.startMaintenance(kind);
      return context.json({ ok: true }, 202);
    });

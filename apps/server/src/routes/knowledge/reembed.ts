// 重嵌任务：显式资产清单入队（整库重建 = 先取 stale 清单再整单传入）与任务查询/重试/取消。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { KbManager } from '@ema-agent/knowledge';
import { knowledgeError } from './errors.js';

export interface KnowledgeReembedRouteDeps {
  readonly kb: Pick<
    KbManager,
    'enqueueReembed' | 'listStaleAssetIds' | 'listReembedTasks' | 'retryReembed' | 'cancelReembed'
  >;
}

const reembedBody = z.object({
  kbId: z.string().optional(),
  assetIds: z.array(z.string().min(1)).min(1),
});

const kbIdQuery = z.object({
  kbId: z.string().optional(),
});

export function knowledgeReembedRoute(deps: KnowledgeReembedRouteDeps): Hono {
  const app = new Hono();

  app.post('/reembed', async context => {
    const parsed = reembedBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      const tasks = await deps.kb.enqueueReembed({
        assetIds: parsed.data.assetIds,
        ...(parsed.data.kbId === undefined ? {} : { kbId: parsed.data.kbId }),
      });
      return context.json({ items: tasks }, 202);
    } catch (error) {
      const mapped = knowledgeError(context, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  // 静态段先于 /reembed-tasks 的参数路径注册不需要——路径不冲突；stale 清单供整库重建取单。
  app.get('/reembed/stale-assets', async context => {
    const parsed = kbIdQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    return respond(context, async () => ({ items: await deps.kb.listStaleAssetIds(parsed.data.kbId) }));
  });

  app.get('/reembed-tasks', async context => {
    const parsed = kbIdQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    return respond(context, async () => ({ items: await deps.kb.listReembedTasks(parsed.data.kbId) }));
  });

  app.post('/reembed-tasks/:taskId/retry', async context => {
    const parsed = kbIdQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      const task = await deps.kb.retryReembed(context.req.param('taskId'), parsed.data.kbId);
      if (!task) return context.json({ error: 'not_failed_or_not_found' }, 404);
      return context.json(task);
    } catch (error) {
      const mapped = knowledgeError(context, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/reembed-tasks/:taskId/cancel', async context => {
    const parsed = kbIdQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const ok = await deps.kb.cancelReembed(context.req.param('taskId'), parsed.data.kbId);
    if (!ok) return context.json({ error: 'not_active_or_not_found' }, 404);
    return context.json({ ok: true });
  });

  return app;
}

async function respond(context: Context, run: () => Promise<unknown>): Promise<Response> {
  try {
    return context.json(await run());
  } catch (error) {
    const mapped = knowledgeError(context, error);
    if (mapped) return mapped;
    throw error;
  }
}

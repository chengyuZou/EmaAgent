// 重嵌任务：显式资产清单入队（整库重建 = 先取 stale 清单再整单传入）与任务查询/重试/取消。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { KbManager } from '@ema-agent/knowledge';
import { knowledgeError } from './errors.js';
import { jsonBody, queryValidator } from '../validate.js';

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

export const knowledgeReembedRoute = (deps: KnowledgeReembedRouteDeps) =>
  new Hono()
    .post('/reembed', jsonBody(reembedBody), async context => {
      const { assetIds, kbId } = context.req.valid('json');
      try {
        const tasks = await deps.kb.enqueueReembed({
          assetIds,
          ...(kbId === undefined ? {} : { kbId }),
        });
        return context.json({ items: tasks }, 202);
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    // 静态段先于 /reembed-tasks 的参数路径注册不需要——路径不冲突；stale 清单供整库重建取单。
    .get('/reembed/stale-assets', queryValidator(kbIdQuery), async context => {
      return respond(context, async () => ({ items: await deps.kb.listStaleAssetIds(context.req.valid('query').kbId) }));
    })
    .get('/reembed-tasks', queryValidator(kbIdQuery), async context => {
      return respond(context, async () => ({ items: await deps.kb.listReembedTasks(context.req.valid('query').kbId) }));
    })
    .post('/reembed-tasks/:taskId/retry', queryValidator(kbIdQuery), async context => {
      try {
        const task = await deps.kb.retryReembed(context.req.param('taskId'), context.req.valid('query').kbId);
        if (!task) return context.json({ error: 'not_failed_or_not_found' }, 404);
        return context.json(task);
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .post('/reembed-tasks/:taskId/cancel', queryValidator(kbIdQuery), async context => {
      const ok = await deps.kb.cancelReembed(context.req.param('taskId'), context.req.valid('query').kbId);
      if (!ok) return context.json({ error: 'not_active_or_not_found' }, 404);
      return context.json({ ok: true });
    });

async function respond(context: Context, run: () => Promise<unknown>): Promise<Response> {
  try {
    return context.json(await run());
  } catch (error) {
    const mapped = knowledgeError(context, error);
    if (mapped) return mapped;
    throw error;
  }
}

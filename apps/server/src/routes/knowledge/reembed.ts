// 重嵌任务：显式资产清单入队（整库重建 = 先取 stale 清单再整单传入）与任务查询/重试/取消/删除。
import { Hono } from 'hono';
import { z } from 'zod';
import type { KbManager } from '@ema-agent/knowledge';
import { knowledgeError } from './errors.js';
import { jsonBody } from '../validate.js';

export interface KnowledgeReembedRouteDeps {
  readonly kb: Pick<
    KbManager,
    'enqueueReembed' | 'listStaleAssetIds' | 'listReembedTasks' | 'retryReembed' | 'cancelReembed' | 'deleteReembedTask'
  >;
}

const reembedBody = z.object({
  assetIds: z.array(z.string().min(1)).min(1),
});

export const knowledgeReembedRoute = (deps: KnowledgeReembedRouteDeps) =>
  new Hono()
    .post('/:id/reembed', jsonBody(reembedBody), async context => {
      try {
        const tasks = await deps.kb.enqueueReembed(context.req.param('id'), {
          assetIds: context.req.valid('json').assetIds,
        });
        return context.json({ items: tasks }, 202);
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    // 静态段 stale-assets 先于 :taskId 注册;stale 清单供整库重建取单。
    .get('/:id/reembed/stale-assets', async context => {
      try {
        return context.json({ items: await deps.kb.listStaleAssetIds(context.req.param('id')) });
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .get('/:id/reembed-tasks', async context => {
      try {
        return context.json({ items: await deps.kb.listReembedTasks(context.req.param('id')) });
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .post('/:id/reembed-tasks/:taskId/retry', async context => {
      try {
        const task = await deps.kb.retryReembed(context.req.param('id'), context.req.param('taskId'));
        if (!task) return context.json({ error: 'not_failed_or_not_found' }, 404);
        return context.json(task);
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .post('/:id/reembed-tasks/:taskId/cancel', async context => {
      const ok = await deps.kb.cancelReembed(context.req.param('id'), context.req.param('taskId'));
      if (!ok) return context.json({ error: 'not_active_or_not_found' }, 404);
      return context.json({ ok: true });
    })
    .delete('/:id/reembed-tasks/:taskId', async context => {
      try {
        const ok = await deps.kb.deleteReembedTask(context.req.param('id'), context.req.param('taskId'));
        if (!ok) return context.json({ error: 'task_not_found' }, 404);
        return context.json({ ok: true });
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    });

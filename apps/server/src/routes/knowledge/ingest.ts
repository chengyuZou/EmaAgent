// 摄入任务：文件入队（staging 在入队时同步执行，失败不产生任务）与任务列表/重试/取消/删除。
import { Hono } from 'hono';
import { z } from 'zod';
import type { KbManager } from '@ema-agent/knowledge';
import { knowledgeError } from './errors.js';
import { jsonBody } from '../validate.js';

export interface KnowledgeIngestRouteDeps {
  readonly kb: Pick<
    KbManager,
    'enqueueIngest' | 'listIngestTasks' | 'retryIngest' | 'cancelIngest' | 'deleteIngestTask'
  >;
}

const ingestBody = z.object({
  filePath: z.string().min(1),
  mimeType: z.string().optional(),
});

export const knowledgeIngestRoute = (deps: KnowledgeIngestRouteDeps) =>
  new Hono()
    .post('/:id/ingest', jsonBody(ingestBody), async context => {
      const { filePath, mimeType } = context.req.valid('json');
      try {
        const task = await deps.kb.enqueueIngest(context.req.param('id'), {
          filePath,
          fileName: filePath.split(/[\\/]/).pop() ?? filePath,
          ...(mimeType === undefined ? {} : { mimeType }),
        });
        return context.json(task, 202);
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .get('/:id/ingest-tasks', async context => {
      try {
        return context.json({ items: await deps.kb.listIngestTasks(context.req.param('id')) });
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .post('/:id/ingest-tasks/:taskId/retry', async context => {
      try {
        const task = await deps.kb.retryIngest(context.req.param('id'), context.req.param('taskId'));
        if (!task) return context.json({ error: 'not_failed_or_not_found' }, 404);
        return context.json(task);
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .post('/:id/ingest-tasks/:taskId/cancel', async context => {
      const ok = await deps.kb.cancelIngest(context.req.param('id'), context.req.param('taskId'));
      if (!ok) return context.json({ error: 'not_active_or_not_found' }, 404);
      return context.json({ ok: true });
    })
    .delete('/:id/ingest-tasks/:taskId', async context => {
      try {
        const ok = await deps.kb.deleteIngestTask(context.req.param('id'), context.req.param('taskId'));
        if (!ok) return context.json({ error: 'task_not_found' }, 404);
        return context.json({ ok: true });
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    });

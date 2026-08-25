// 摄入任务：文件入队（staging 在入队时同步执行，失败不产生任务）与任务列表/重试/取消。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { KbManager } from '@ema-agent/knowledge';
import { knowledgeError } from './errors.js';
import { jsonBody, queryValidator } from '../validate.js';

export interface KnowledgeIngestRouteDeps {
  readonly kb: Pick<
    KbManager,
    'enqueueIngest' | 'listIngestTasks' | 'retryIngest' | 'cancelIngest'
  >;
}

const ingestBody = z.object({
  filePath: z.string().min(1),
  mimeType: z.string().optional(),
  kbId: z.string().optional(),
});

const kbIdQuery = z.object({
  kbId: z.string().optional(),
});

export const knowledgeIngestRoute = (deps: KnowledgeIngestRouteDeps) =>
  new Hono()
    .post('/ingest', jsonBody(ingestBody), async context => {
      const { filePath, mimeType, kbId } = context.req.valid('json');
      try {
        const task = await deps.kb.enqueueIngest({
          filePath,
          fileName: filePath.split(/[\\/]/).pop() ?? filePath,
          ...(mimeType === undefined ? {} : { mimeType }),
          ...(kbId === undefined ? {} : { kbId }),
        });
        return context.json(task, 202);
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .get('/ingest-tasks', queryValidator(kbIdQuery), async context => {
      return respondTasks(context, () => deps.kb.listIngestTasks(context.req.valid('query').kbId));
    })
    .post('/ingest-tasks/:taskId/retry', queryValidator(kbIdQuery), async context => {
      const task = await deps.kb.retryIngest(context.req.param('taskId'), context.req.valid('query').kbId);
      if (!task) return context.json({ error: 'not_failed_or_not_found' }, 404);
      return context.json(task);
    })
    .post('/ingest-tasks/:taskId/cancel', queryValidator(kbIdQuery), async context => {
      const ok = await deps.kb.cancelIngest(context.req.param('taskId'), context.req.valid('query').kbId);
      if (!ok) return context.json({ error: 'not_active_or_not_found' }, 404);
      return context.json({ ok: true });
    });

async function respondTasks(
  context: Context,
  run: () => Promise<unknown>,
): Promise<Response> {
  try {
    return context.json({ items: await run() });
  } catch (error) {
    const mapped = knowledgeError(context, error);
    if (mapped) return mapped;
    throw error;
  }
}

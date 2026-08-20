// 摄入任务：文件入队（staging 在入队时同步执行，失败不产生任务）与任务列表/重试/取消。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { KbManager } from '@ema-agent/knowledge';
import { knowledgeError } from './errors.js';

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

export function knowledgeIngestRoute(deps: KnowledgeIngestRouteDeps): Hono {
  const app = new Hono();

  app.post('/ingest', async context => {
    const parsed = ingestBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const { filePath, mimeType, kbId } = parsed.data;
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
  });

  app.get('/ingest-tasks', async context => {
    const parsed = kbIdQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    return respondTasks(context, () => deps.kb.listIngestTasks(parsed.data.kbId));
  });

  app.post('/ingest-tasks/:taskId/retry', async context => {
    const parsed = kbIdQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const task = await deps.kb.retryIngest(context.req.param('taskId'), parsed.data.kbId);
    if (!task) return context.json({ error: 'not_failed_or_not_found' }, 404);
    return context.json(task);
  });

  app.post('/ingest-tasks/:taskId/cancel', async context => {
    const parsed = kbIdQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const ok = await deps.kb.cancelIngest(context.req.param('taskId'), parsed.data.kbId);
    if (!ok) return context.json({ error: 'not_active_or_not_found' }, 404);
    return context.json({ ok: true });
  });

  return app;
}

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

// 知识库检索：当前活跃库的混合检索；assetIds 由前端按用户选择冻结传入（缺省全库）。
import { Hono } from 'hono';
import { z } from 'zod';
import type { KbManager } from '@ema-agent/knowledge';
import { knowledgeError } from './errors.js';

export interface KnowledgeSearchRouteDeps {
  readonly kb: Pick<KbManager, 'search'>;
}

const searchBody = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(20).optional(),
  assetIds: z.array(z.string().min(1)).optional(),
});

export function knowledgeSearchRoute(deps: KnowledgeSearchRouteDeps): Hono {
  const app = new Hono();

  app.post('/search', async context => {
    const parsed = searchBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      return context.json(await deps.kb.search({
        query: parsed.data.query,
        ...(parsed.data.topK === undefined ? {} : { topK: parsed.data.topK }),
        ...(parsed.data.assetIds === undefined ? {} : { assetIds: parsed.data.assetIds }),
        signal: context.req.raw.signal,
      }));
    } catch (error) {
      const mapped = knowledgeError(context, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  return app;
}

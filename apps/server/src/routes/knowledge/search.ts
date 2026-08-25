// 知识库检索：当前活跃库的混合检索；assetIds 由前端按用户选择冻结传入（缺省全库）。
import { Hono } from 'hono';
import { z } from 'zod';
import type { KbManager } from '@ema-agent/knowledge';
import { knowledgeError } from './errors.js';
import { jsonBody } from '../validate.js';

export interface KnowledgeSearchRouteDeps {
  readonly kb: Pick<KbManager, 'search'>;
}

const searchBody = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(20).optional(),
  assetIds: z.array(z.string().min(1)).optional(),
});

export const knowledgeSearchRoute = (deps: KnowledgeSearchRouteDeps) =>
  new Hono()
    .post('/search', jsonBody(searchBody), async context => {
      const { query, topK, assetIds } = context.req.valid('json');
      try {
        return context.json(await deps.kb.search({
          query,
          ...(topK === undefined ? {} : { topK }),
          ...(assetIds === undefined ? {} : { assetIds }),
          signal: context.req.raw.signal,
        }));
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    });

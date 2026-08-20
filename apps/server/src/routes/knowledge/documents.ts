// 文档资产查询与删除：分页列表、沉淀清单、详情/预览/分块/使用统计；kbId 缺省为当前活跃库。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { KbManager } from '@ema-agent/knowledge';
import { knowledgeError } from './errors.js';

export interface KnowledgeDocumentsRouteDeps {
  readonly kb: Pick<
    KbManager,
    | 'listAssets'
    | 'listInactiveAssets'
    | 'getAsset'
    | 'getPreview'
    | 'getChunks'
    | 'getAssetUsage'
    | 'deleteAsset'
  >;
}

const listQuery = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  keyword: z.string().optional(),
  kbId: z.string().optional(),
});

const staleQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).optional(),
  kbId: z.string().optional(),
});

const chunkQuery = z.object({
  cursor: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  kbId: z.string().optional(),
});

export function knowledgeDocumentsRoute(deps: KnowledgeDocumentsRouteDeps): Hono {
  const app = new Hono();
  const respond = async (context: Context, run: () => unknown | Promise<unknown>): Promise<Response> => {
    try {
      return context.json(await run());
    } catch (error) {
      const mapped = knowledgeError(context, error);
      if (mapped) return mapped;
      throw error;
    }
  };

  app.get('/documents', async context => {
    const parsed = listQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const { kbId, ...options } = parsed.data;
    return respond(context, () => deps.kb.listAssets(kbId, options));
  });

  // 静态段先于 /documents/:id 注册；沉淀 = 最近 N 天未被选入 Turn 的资产。
  app.get('/documents/stale', async context => {
    const parsed = staleQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    return respond(context, async () => ({
      items: await deps.kb.listInactiveAssets(parsed.data.kbId, parsed.data.days ?? 30),
    }));
  });

  app.get('/documents/:id', async context => {
    const asset = await deps.kb.getAsset(context.req.param('id'), kbIdFrom(context));
    if (!asset) return context.json({ error: 'asset_not_found' }, 404);
    return context.json(asset);
  });

  app.get('/documents/:id/preview', async context => {
    const preview = await deps.kb.getPreview(context.req.param('id'), kbIdFrom(context));
    if (!preview) return context.json({ error: 'asset_not_found' }, 404);
    return context.json(preview);
  });

  app.get('/documents/:id/chunks', async context => {
    const parsed = chunkQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const { kbId, ...options } = parsed.data;
    return respond(context, () => deps.kb.getChunks(context.req.param('id'), kbId, options));
  });

  app.get('/documents/:id/usage', async context => {
    return respond(context, () => deps.kb.getAssetUsage(context.req.param('id'), kbIdFrom(context)));
  });

  app.delete('/documents/:id', async context => {
    const deleted = await deps.kb.deleteAsset(context.req.param('id'), kbIdFrom(context));
    if (!deleted) return context.json({ error: 'asset_not_found' }, 404);
    return context.json({ ok: true });
  });

  return app;
}

/** query 里的可选 kbId（空串按缺省处理）。 */
function kbIdFrom(context: Context): string | undefined {
  return context.req.query('kbId') || undefined;
}

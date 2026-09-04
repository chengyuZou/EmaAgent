// 文档资产查询与删除：分页列表、详情/预览/分块；路径段携带目标库 id。
import { Hono } from 'hono';
import { z } from 'zod';
import type { KbManager } from '@ema-agent/knowledge';
import { knowledgeError } from './errors.js';
import { queryValidator } from '../validate.js';

export interface KnowledgeDocumentsRouteDeps {
  readonly kb: Pick<
    KbManager,
    | 'listAssets'
    | 'getAsset'
    | 'getPreview'
    | 'getChunks'
    | 'deleteAsset'
  >;
}

const listQuery = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  keyword: z.string().optional(),
});

const chunkQuery = z.object({
  cursor: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const knowledgeDocumentsRoute = (deps: KnowledgeDocumentsRouteDeps) =>
  new Hono()
    .get('/:id/documents', queryValidator(listQuery), async context => {
      try {
        return context.json(await deps.kb.listAssets(context.req.param('id'), context.req.valid('query')));
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .get('/:id/documents/:docId', async context => {
      const asset = await deps.kb.getAsset(context.req.param('id'), context.req.param('docId'));
      if (!asset) return context.json({ error: 'asset_not_found' }, 404);
      return context.json(asset);
    })
    .get('/:id/documents/:docId/preview', async context => {
      const preview = await deps.kb.getPreview(context.req.param('id'), context.req.param('docId'));
      if (!preview) return context.json({ error: 'asset_not_found' }, 404);
      return context.json(preview);
    })
    .get('/:id/documents/:docId/chunks', queryValidator(chunkQuery), async context => {
      try {
        return context.json(await deps.kb.getChunks(context.req.param('id'), context.req.param('docId'), context.req.valid('query')));
      } catch (error) {
        const mapped = knowledgeError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .delete('/:id/documents/:docId', async context => {
      const deleted = await deps.kb.deleteAsset(context.req.param('id'), context.req.param('docId'));
      if (!deleted) return context.json({ error: 'asset_not_found' }, 404);
      return context.json({ ok: true });
    });

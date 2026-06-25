import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../wiring.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const ingestBody = z.object({
  filePath:         z.string().min(1),
  ebdProviderId:    z.string().optional(),
  ebdModel:         z.string().optional(),
  visionProviderId: z.string().optional(),
  visionModel:      z.string().optional(),
  mimeType:         z.string().optional(),
});

const listQuery = z.object({
  cursor:  z.coerce.number().int().optional(),
  limit:   z.coerce.number().int().min(1).max(100).optional(),
  keyword: z.string().optional(),
});

const searchBody = z.object({
  query:            z.string().min(1),
  // Selected KB asset ids for this turn. Omit = search all KBs; [] = none.
  assetIds:         z.array(z.string()).optional(),
  topK:             z.number().int().min(1).max(50).optional(),
  alpha:            z.number().min(0).max(1).optional(),
  ebdProviderId:    z.string().optional(),
  ebdModel:         z.string().optional(),
  rerankProviderId: z.string().optional(),
  rerankModel:      z.string().optional(),
});

const staleQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).optional(),
});

const chunkQuery = z.object({
  cursor: z.coerce.number().int().optional(),
  limit:  z.coerce.number().int().min(1).max(100).optional(),
});

const invalidateBody = z.object({
  newModel: z.string().min(1),
});

const reembedBody = z.object({
  ebdProviderId: z.string().min(1).optional(),
  ebdModel:      z.string().min(1).optional(),
});

// ── Binding resolution ──────────────────────────────────────────────────────────

/** KB's own embed/rerank model choice (app settings, NOT model_bindings — those
 *  are LightRAG's). One key so the two move together. See settings.ts. */
interface KbModelsSetting {
  embed?:  { providerConfigId: string; model: string };
  rerank?: { providerConfigId: string; model: string };
}

/**
 * Resolve the embed/vision/rerank models for KB ingest/search. embed + rerank
 * come from the KB-specific `kb.models` setting (decoupled from LightRAG's
 * lightrag-embed binding); vision still rides the global `vision` binding.
 * This lets the KB UI stay dumb (send no model ids) yet still get dense + OCR.
 */
function resolveBoundModels(bindings: AppBindings): {
  ebdProviderId?:    string; ebdModel?:    string;
  visionProviderId?: string; visionModel?: string;
  rerankProviderId?: string; rerankModel?: string;
} {
  const kb     = (bindings.settings.get('kb.models') as KbModelsSetting | undefined) ?? {};
  const vision = bindings.modelBindings.get('vision');
  return {
    ebdProviderId:    kb.embed?.providerConfigId,
    ebdModel:         kb.embed?.model,
    visionProviderId: vision?.providerConfigId,
    visionModel:      vision?.model,
    rerankProviderId: kb.rerank?.providerConfigId,
    rerankModel:      kb.rerank?.model,
  };
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function kbRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // POST /api/kb/documents — ingest a file into the knowledge base
  app.post('/documents', async (c) => {
    const parsed = ingestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const { filePath, ebdProviderId, ebdModel, visionProviderId, visionModel, mimeType } = parsed.data;
    const bound = resolveBoundModels(bindings);

    try {
      const result = await bindings.kb.ingest(filePath, {
        ebdProviderId:    ebdProviderId    ?? bound.ebdProviderId,
        ebdModel:         ebdModel         ?? bound.ebdModel,
        visionProviderId: visionProviderId ?? bound.visionProviderId,
        visionModel:      visionModel      ?? bound.visionModel,
        mimeType,
      });
      return c.json({
        assetId:   result.asset.id,
        fileName:  result.asset.fileName,
        chunks:    result.chunks,
        pageCount: result.asset.pageCount,
        wordCount: result.asset.wordCount,
        status:    result.asset.status,
      }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('validation failed'))
        return c.json({ error: 'unsupported_file', message: msg }, 422);
      return c.json({ error: 'ingest_failed', message: msg }, 500);
    }
  });

  // GET /api/kb/documents — cursor-paginated list (newest first), optional keyword
  app.get('/documents', (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const page = bindings.kb.listAssets(parsed.data);
    return c.json(page);
  });

  // GET /api/kb/documents-stale — KBs not selected in the last N days (default 30)
  app.get('/documents-stale', (c) => {
    const parsed = staleQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    return c.json(bindings.kb.listInactiveAssets(parsed.data.days ?? 30));
  });

  // GET /api/kb/documents/:id — get single asset metadata
  app.get('/documents/:id', (c) => {
    const asset = bindings.kb.getAsset(c.req.param('id'));
    if (!asset) return c.json({ error: 'not_found' }, 404);
    return c.json(asset);
  });

  // GET /api/kb/documents/:id/preview — get document preview text
  app.get('/documents/:id/preview', (c) => {
    const preview = bindings.kb.getPreview(c.req.param('id'));
    if (!preview) return c.json({ error: 'not_found' }, 404);
    return c.json(preview);
  });

  // GET /api/kb/documents/:id/chunks — cursor-paginated chunk summaries
  app.get('/documents/:id/chunks', (c) => {
    const parsed = chunkQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    return c.json(bindings.kb.getChunksPaged(c.req.param('id'), parsed.data));
  });

  // GET /api/kb/documents/:id/usage — which sessions used this KB + how many calls
  app.get('/documents/:id/usage', (c) => {
    return c.json(bindings.kb.getAssetUsage(c.req.param('id')));
  });

  // DELETE /api/kb/documents/:id — remove asset + all its chunks
  app.delete('/documents/:id', (c) => {
    const id = c.req.param('id');
    const asset = bindings.kb.getAsset(id);
    if (!asset) return c.json({ error: 'not_found' }, 404);
    bindings.kb.deleteAsset(id);
    return c.json({ deleted: id });
  });

  // POST /api/kb/search — hybrid retrieval
  app.post('/search', async (c) => {
    const parsed = searchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const bound = resolveBoundModels(bindings);
    const opts = {
      ...parsed.data,
      ebdProviderId:    parsed.data.ebdProviderId    ?? bound.ebdProviderId,
      ebdModel:         parsed.data.ebdModel         ?? bound.ebdModel,
      rerankProviderId: parsed.data.rerankProviderId ?? bound.rerankProviderId,
      rerankModel:      parsed.data.rerankModel       ?? bound.rerankModel,
    };

    try {
      const result = await bindings.kb.search(parsed.data.query, opts);
      return c.json(result);
    } catch (err) {
      return c.json({ error: 'search_failed', message: (err as Error).message }, 500);
    }
  });

  // POST /api/kb/invalidate — mark all embeddings stale (call when embed model changes)
  app.post('/invalidate', async (c) => {
    const parsed = invalidateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const count = bindings.kb.invalidateEmbeddings(parsed.data.newModel);
    return c.json({ markedStale: count });
  });

  // POST /api/kb/reembed — re-embed all stale assets in the background
  app.post('/reembed', async (c) => {
    const parsed = reembedBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const bound = resolveBoundModels(bindings);
    const ebdProviderId = parsed.data.ebdProviderId ?? bound.ebdProviderId;
    const ebdModel      = parsed.data.ebdModel      ?? bound.ebdModel;
    if (!ebdProviderId || !ebdModel) {
      return c.json({ error: 'no_embed_binding', message: '未配置 Embedding 模型，无法重建索引' }, 400);
    }
    try {
      const result = await bindings.kb.reembed({ ebdProviderId, ebdModel });
      return c.json(result);
    } catch (err) {
      return c.json({ error: 'reembed_failed', message: (err as Error).message }, 500);
    }
  });

  return app;
}

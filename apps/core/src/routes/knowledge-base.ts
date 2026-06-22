import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../wiring.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const ingestBody = z.object({
  filePath:       z.string().min(1),
  ebdProviderId:  z.string().optional(),
  ebdModel:       z.string().optional(),
  mimeType:       z.string().optional(),
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

const invalidateBody = z.object({
  newModel: z.string().min(1),
});

const reembedBody = z.object({
  ebdProviderId: z.string().min(1),
  ebdModel:      z.string().min(1),
});

// ── Route factory ─────────────────────────────────────────────────────────────

export function kbRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // POST /api/kb/documents — ingest a file into the knowledge base
  app.post('/documents', async (c) => {
    const parsed = ingestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const { filePath, ebdProviderId, ebdModel, mimeType } = parsed.data;

    try {
      const result = await bindings.kb.ingest(filePath, {
        ebdProviderId,
        ebdModel,
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

    try {
      const result = await bindings.kb.search(parsed.data.query, parsed.data);
      return c.json(result);
    } catch (err) {
      return c.json({ error: 'search_failed', message: (err as Error).message }, 500);
    }
  });

  // POST /api/kb/invalidate — mark all embeddings stale (call when embed model changes)
  app.post('/invalidate', (c) => {
    const parsed = invalidateBody.safeParse(c.req.json());
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

    const { ebdProviderId, ebdModel } = parsed.data;
    try {
      const result = await bindings.kb.reembed({ ebdProviderId, ebdModel });
      return c.json(result);
    } catch (err) {
      return c.json({ error: 'reembed_failed', message: (err as Error).message }, 500);
    }
  });

  return app;
}

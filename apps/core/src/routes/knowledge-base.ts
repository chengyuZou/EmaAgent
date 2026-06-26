import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AppBindings } from '../wiring.js';
import type { KbEntry } from '@ema-agent/knowledge-base';

// ── Schemas ───────────────────────────────────────────────────────────────────

const ingestBody = z.object({
  filePath: z.string().min(1),
  mimeType: z.string().optional(),
});

const listQuery = z.object({
  cursor:  z.coerce.number().int().optional(),
  limit:   z.coerce.number().int().min(1).max(100).optional(),
  keyword: z.string().optional(),
});

const searchBody = z.object({
  query:            z.string().min(1),
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

interface KbModelsSetting {
  embed?:  { providerConfigId: string; model: string };
  rerank?: { providerConfigId: string; model: string };
}

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

/** Resolve the active KB entry or return a 503 JSON response. */
async function requireActiveEntry(
  bindings: AppBindings,
  c: { json: (body: unknown, status: number) => Response },
): Promise<KbEntry | Response> {
  const entry = await bindings.kb.openActiveEntry();
  if (!entry) return c.json({ error: 'no_active_kb', message: '请先在设置中创建并激活一个知识库' }, 503) as Response;
  return entry;
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function kbRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // POST /api/kb/documents — ingest a file into the active knowledge base
  app.post('/documents', async (c) => {
    const parsed = ingestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    const { filePath, mimeType } = parsed.data;
    const assetId  = randomUUID();
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;

    entry.ingestQueue.enqueue({ id: assetId, filePath, fileName, mimeType });

    return c.json({ assetId, fileName, status: 'pending' }, 202);
  });

  // GET /api/kb/documents — cursor-paginated list (newest first), optional keyword
  app.get('/documents', async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    return c.json(entry.client.listAssets(parsed.data));
  });

  // GET /api/kb/documents-stale — KBs not selected in the last N days (default 30)
  app.get('/documents-stale', async (c) => {
    const parsed = staleQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    return c.json(entry.client.listInactiveAssets(parsed.data.days ?? 30));
  });

  // GET /api/kb/documents/:id — get single asset metadata
  app.get('/documents/:id', async (c) => {
    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    const asset = entry.client.getAsset(c.req.param('id'));
    if (!asset) return c.json({ error: 'not_found' }, 404);
    return c.json(asset);
  });

  // GET /api/kb/documents/:id/preview
  app.get('/documents/:id/preview', async (c) => {
    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    const preview = entry.client.getPreview(c.req.param('id'));
    if (!preview) return c.json({ error: 'not_found' }, 404);
    return c.json(preview);
  });

  // GET /api/kb/documents/:id/chunks — cursor-paginated chunk summaries
  app.get('/documents/:id/chunks', async (c) => {
    const parsed = chunkQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    return c.json(entry.client.getChunksPaged(c.req.param('id'), parsed.data));
  });

  // GET /api/kb/documents/:id/usage — which sessions used this KB doc
  app.get('/documents/:id/usage', async (c) => {
    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    return c.json(entry.client.getAssetUsage(c.req.param('id')));
  });

  // GET /api/kb/ingest-tasks — the background ingest queue (pending/running/failed)
  app.get('/ingest-tasks', async (c) => {
    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    return c.json(entry.ingestTasks.listActive());
  });

  // POST /api/kb/documents/:id/retry — re-queue a failed ingest task
  app.post('/documents/:id/retry', async (c) => {
    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    const ok = entry.ingestQueue.retry(c.req.param('id'));
    if (!ok) return c.json({ error: 'not_failed_or_not_found' }, 404);
    return c.json({ ok: true });
  });

  // POST /api/kb/documents/:id/reembed — re-embed a single doc with the current model
  app.post('/documents/:id/reembed', async (c) => {
    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    const bound = resolveBoundModels(bindings);
    if (!bound.ebdProviderId || !bound.ebdModel)
      return c.json({ error: 'no_embed_model' }, 400);

    const ok = await entry.client.reembedAsset(c.req.param('id'),
      { ebdProviderId: bound.ebdProviderId, ebdModel: bound.ebdModel });
    return ok ? c.json({ ok: true }) : c.json({ error: 'reembed_failed' }, 500);
  });

  // DELETE /api/kb/documents/:id — remove asset + all its chunks
  app.delete('/documents/:id', async (c) => {
    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    const id = c.req.param('id');
    const asset = entry.client.getAsset(id);
    if (!asset) return c.json({ error: 'not_found' }, 404);
    entry.client.deleteAsset(id);
    return c.json({ deleted: id });
  });

  // POST /api/kb/search — hybrid retrieval
  app.post('/search', async (c) => {
    const parsed = searchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    const bound = resolveBoundModels(bindings);
    const opts = {
      ...parsed.data,
      ebdProviderId:    parsed.data.ebdProviderId    ?? bound.ebdProviderId,
      ebdModel:         parsed.data.ebdModel         ?? bound.ebdModel,
      rerankProviderId: parsed.data.rerankProviderId ?? bound.rerankProviderId,
      rerankModel:      parsed.data.rerankModel       ?? bound.rerankModel,
    };

    try {
      const result = await entry.client.search(parsed.data.query, opts);
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

    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    const count = entry.client.invalidateEmbeddings(parsed.data.newModel);
    return c.json({ markedStale: count });
  });

  // POST /api/kb/reembed — re-embed all stale assets in the background
  app.post('/reembed', async (c) => {
    const parsed = reembedBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const entry = await requireActiveEntry(bindings, c);
    if (entry instanceof Response) return entry;

    const bound = resolveBoundModels(bindings);
    const ebdProviderId = parsed.data.ebdProviderId ?? bound.ebdProviderId;
    const ebdModel      = parsed.data.ebdModel      ?? bound.ebdModel;
    if (!ebdProviderId || !ebdModel)
      return c.json({ error: 'no_embed_binding', message: '未配置 Embedding 模型，无法重建索引' }, 400);

    try {
      const result = await entry.client.reembed({ ebdProviderId, ebdModel });
      return c.json(result);
    } catch (err) {
      return c.json({ error: 'reembed_failed', message: (err as Error).message }, 500);
    }
  });

  // ── KB registry routes (Phase 3 will expand these) ────────────────────────

  // GET /api/kb/libs — list all registered KBs
  app.get('/libs', (c) => {
    return c.json(bindings.kb.listKbs());
  });

  // POST /api/kb/libs — create a new named KB
  app.post('/libs', async (c) => {
    const body = z.object({ name: z.string().min(1), path: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);

    try {
      const record = await bindings.kb.createKb(body.data.name, body.data.path);
      return c.json(record, 201);
    } catch (err) {
      return c.json({ error: 'create_failed', message: (err as Error).message }, 500);
    }
  });

  // PATCH /api/kb/libs/:id — rename
  app.patch('/libs/:id', async (c) => {
    const body = z.object({ name: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);

    bindings.kb.renameKb(c.req.param('id'), body.data.name);
    return c.json({ ok: true });
  });

  // POST /api/kb/libs/:id/activate — set as active KB
  app.post('/libs/:id/activate', (c) => {
    const rec = bindings.kb.getKb(c.req.param('id'));
    if (!rec) return c.json({ error: 'not_found' }, 404);
    bindings.kb.setActiveKb(rec.id);
    return c.json({ ok: true });
  });

  // DELETE /api/kb/libs/:id — unregister (no disk delete)
  app.delete('/libs/:id', (c) => {
    const rec = bindings.kb.getKb(c.req.param('id'));
    if (!rec) return c.json({ error: 'not_found' }, 404);
    bindings.kb.unregisterKb(rec.id);
    return c.json({ ok: true });
  });

  return app;
}

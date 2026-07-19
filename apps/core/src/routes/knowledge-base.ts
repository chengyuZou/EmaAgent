import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AppBindings } from '../wiring/index.js';
import type { KbEntry } from '@ema-agent/knowledge-base';
import { DocumentAssetCursorError } from '@ema-agent/storage';

// ── Schemas ───────────────────────────────────────────────────────────────────

const ingestBody = z.object({
  filePath: z.string().min(1),
  mimeType: z.string().optional(),
  /** Target KB id. Omit → active KB. */
  kbId:     z.string().optional(),
});

const listQuery = z.object({
  cursor:  z.string().min(1).max(1024).optional(),
  limit:   z.coerce.number().int().min(1).max(100).optional(),
  keyword: z.string().optional(),
  /** Target KB id. Omit → active KB. */
  kbId:    z.string().optional(),
});

const searchBody = z.object({
  query:            z.string().min(1),
  /** KB ids to search. [] / omit → active KB; [id1, id2] → multi-KB merge. */
  kbIds:            z.array(z.string()).optional(),
  topK:             z.number().int().min(1).max(50).optional(),
  alpha:            z.number().min(0).max(1).optional(),
  ebdProviderId:    z.string().optional(),
  ebdModel:         z.string().optional(),
  rerankProviderId: z.string().optional(),
  rerankModel:      z.string().optional(),
});

const staleQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).optional(),
  kbId: z.string().optional(),
});

const chunkQuery = z.object({
  cursor: z.coerce.number().int().optional(),
  limit:  z.coerce.number().int().min(1).max(100).optional(),
  kbId:   z.string().optional(),
});

const kbIdQuery = z.object({
  kbId: z.string().optional(),
});

const invalidateBody = z.object({
  ebdProviderId: z.string().min(1),
  ebdModel:      z.string().min(1),
  kbId:     z.string().optional(),
});

const reembedBody = z.object({
  ebdProviderId: z.string().min(1).optional(),
  ebdModel:      z.string().min(1).optional(),
  kbId:          z.string().optional(),
});

// ── Binding resolution ────────────────────────────────────────────────────────

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

/**
 * Resolve a KB entry for a request.
 * - kbId provided → open that specific KB (404 if not registered)
 * - kbId omitted  → use the active KB (503 if none active)
 */
async function resolveEntry(
  bindings: AppBindings,
  kbId: string | undefined,
  c: { json: (body: unknown, status: number) => Response },
): Promise<KbEntry | Response> {
  if (kbId) {
    const rec = bindings.kb.getKb(kbId);
    if (!rec) return c.json({ error: 'not_found', message: `知识库未找到: ${kbId}` }, 404) as Response;
    return bindings.kb.openClient(kbId);
  }
  const entry = await bindings.kb.openActiveEntry();
  if (!entry) return c.json({ error: 'no_active_kb', message: '请先在设置中创建并激活一个知识库' }, 503) as Response;
  return entry;
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function kbRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // POST /api/kb/documents — ingest a file into a KB (default: active)
  app.post('/documents', async (c) => {
    const parsed = ingestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const entry = await resolveEntry(bindings, parsed.data.kbId, c);
    if (entry instanceof Response) return entry;

    const { filePath, mimeType } = parsed.data;
    const assetId  = randomUUID();
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;

    const task = entry.ingestQueue.enqueue({ assetId, filePath, fileName, mimeType });

    return c.json({ taskId: task.id, assetId, fileName, status: 'pending' }, 202);
  });

  // GET /api/kb/documents — cursor-paginated list (newest first), optional keyword
  app.get('/documents', async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const { kbId, ...listOpts } = parsed.data;
    const entry = await resolveEntry(bindings, kbId, c);
    if (entry instanceof Response) return entry;

    try {
      return c.json(entry.client.listAssets(listOpts));
    } catch (error) {
      if (error instanceof DocumentAssetCursorError) {
        return c.json({ error: error.code }, 400);
      }
      throw error;
    }
  });

  // GET /api/kb/documents-stale — assets not selected in the last N days
  app.get('/documents-stale', async (c) => {
    const parsed = staleQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const { kbId, days } = parsed.data;
    const entry = await resolveEntry(bindings, kbId, c);
    if (entry instanceof Response) return entry;

    return c.json(entry.client.listInactiveAssets(days ?? 30));
  });

  // GET /api/kb/documents/:id
  app.get('/documents/:id', async (c) => {
    const parsed = kbIdQuery.safeParse(c.req.query());
    const kbId = parsed.success ? parsed.data.kbId : undefined;

    const entry = await resolveEntry(bindings, kbId, c);
    if (entry instanceof Response) return entry;

    const asset = entry.client.getAsset(c.req.param('id'));
    if (!asset) return c.json({ error: 'not_found' }, 404);
    return c.json(asset);
  });

  // GET /api/kb/documents/:id/preview
  app.get('/documents/:id/preview', async (c) => {
    const parsed = kbIdQuery.safeParse(c.req.query());
    const kbId = parsed.success ? parsed.data.kbId : undefined;

    const entry = await resolveEntry(bindings, kbId, c);
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

    const { kbId, ...chunkOpts } = parsed.data;
    const entry = await resolveEntry(bindings, kbId, c);
    if (entry instanceof Response) return entry;

    return c.json(entry.client.getChunksPaged(c.req.param('id'), chunkOpts));
  });

  // GET /api/kb/documents/:id/usage — which sessions used this doc
  app.get('/documents/:id/usage', async (c) => {
    const parsed = kbIdQuery.safeParse(c.req.query());
    const kbId = parsed.success ? parsed.data.kbId : undefined;

    const entry = await resolveEntry(bindings, kbId, c);
    if (entry instanceof Response) return entry;

    return c.json(entry.client.getAssetUsage(c.req.param('id')));
  });

  // GET /api/kb/ingest-tasks — background ingest queue.
  // kbId provided → that KB only; omitted → all registered KBs (each task includes kbId).
  app.get('/ingest-tasks', async (c) => {
    const parsed = kbIdQuery.safeParse(c.req.query());
    const kbId = parsed.success ? parsed.data.kbId : undefined;

    if (kbId) {
      const entry = await resolveEntry(bindings, kbId, c);
      if (entry instanceof Response) return entry;
      return c.json(entry.ingestTasks.listActive().map((t) => ({ ...t, kbId })));
    }

    // No kbId → aggregate across every registered KB.
    const allKbs = bindings.kb.listKbs();
    const results = await Promise.all(
      allKbs.map(async (rec) => {
        try {
          const entry = await bindings.kb.openClient(rec.id);
          return entry.ingestTasks.listActive().map((t) => ({ ...t, kbId: rec.id }));
        } catch { return []; }
      }),
    );
    return c.json(results.flat());
  });

  // POST /api/kb/documents/:id/retry — re-queue a failed ingest task
  app.post('/documents/:id/retry', async (c) => {
    const parsed = kbIdQuery.safeParse(c.req.query());
    const kbId = parsed.success ? parsed.data.kbId : undefined;

    const entry = await resolveEntry(bindings, kbId, c);
    if (entry instanceof Response) return entry;

    const ok = entry.ingestQueue.retryByTaskOrAssetId(c.req.param('id'));
    if (!ok) return c.json({ error: 'not_failed_or_not_found' }, 404);
    return c.json({ ok: true });
  });

  // 新契约明确使用 taskId；旧 documents/:id/retry 暂留给开发期客户端过渡。
  app.post('/ingest-tasks/:taskId/retry', async (c) => {
    const parsed = kbIdQuery.safeParse(c.req.query());
    const entry = await resolveEntry(bindings, parsed.success ? parsed.data.kbId : undefined, c);
    if (entry instanceof Response) return entry;
    const ok = entry.ingestQueue.retry(c.req.param('taskId'));
    if (!ok) return c.json({ error: 'not_failed_or_not_found' }, 404);
    return c.json({ ok: true });
  });

  // POST /api/kb/documents/:id/reembed — 单文档重建索引入队(202 + taskId, 后台执行)
  app.post('/documents/:id/reembed', async (c) => {
    const parsed = kbIdQuery.safeParse(c.req.query());
    const kbId = parsed.success ? parsed.data.kbId : undefined;

    const entry = await resolveEntry(bindings, kbId, c);
    if (entry instanceof Response) return entry;

    if (!entry.client.getAsset(c.req.param('id')))
      return c.json({ error: 'not_found' }, 404);

    const bound = resolveBoundModels(bindings);
    if (!bound.ebdProviderId || !bound.ebdModel)
      return c.json({ error: 'no_embed_model' }, 400);

    const task = entry.reembedQueue.enqueue({
      assetId: c.req.param('id'),
      ebdProviderId: bound.ebdProviderId,
      ebdModel: bound.ebdModel,
    });
    return c.json({ taskId: task.id, status: task.status }, 202);
  });

  // DELETE /api/kb/documents/:id — remove asset + all its chunks
  app.delete('/documents/:id', async (c) => {
    const parsed = kbIdQuery.safeParse(c.req.query());
    const kbId = parsed.success ? parsed.data.kbId : undefined;

    const entry = await resolveEntry(bindings, kbId, c);
    if (entry instanceof Response) return entry;

    const id = c.req.param('id');
    const asset = entry.client.getAsset(id);
    if (!asset) return c.json({ error: 'not_found' }, 404);
    entry.client.deleteAsset(id);
    return c.json({ deleted: id });
  });

  // POST /api/kb/search — hybrid retrieval, optionally across multiple KBs
  app.post('/search', async (c) => {
    const parsed = searchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const bound = resolveBoundModels(bindings);
    const { kbIds = [], ...rest } = parsed.data;
    const opts = {
      ...rest,
      ebdProviderId:    rest.ebdProviderId    ?? bound.ebdProviderId,
      ebdModel:         rest.ebdModel         ?? bound.ebdModel,
      rerankProviderId: rest.rerankProviderId ?? bound.rerankProviderId,
      rerankModel:      rest.rerankModel       ?? bound.rerankModel,
    };

    try {
      const result = await bindings.kb.search(kbIds, parsed.data.query, opts);
      return c.json(result);
    } catch (err) {
      return c.json({ error: 'search_failed', message: (err as Error).message }, 500);
    }
  });

  // POST /api/kb/invalidate — mark embeddings stale after embed model change
  app.post('/invalidate', async (c) => {
    const parsed = invalidateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const { kbId, ebdProviderId, ebdModel } = parsed.data;
    const entry = await resolveEntry(bindings, kbId, c);
    if (entry instanceof Response) return entry;

    const dim = bindings.providerEmbedModels.dimFor(ebdProviderId, ebdModel);
    if (!dim) return c.json({ error: 'unknown_embed_dimension' }, 400);
    const space = bindings.ebd.embeddingSpace(ebdProviderId, ebdModel, dim);
    const count = entry.client.invalidateEmbeddings(space.id);
    return c.json({ markedStale: count, embeddingSpace: space });
  });

  // POST /api/kb/reembed — 全库 stale 重建入队(202 + taskId, 后台执行;
  // 已有 pending/running 任务时幂等复用, 不重复烧 embedding 配额)
  app.post('/reembed', async (c) => {
    const parsed = reembedBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);

    const { kbId, ...reembedOpts } = parsed.data;
    const entry = await resolveEntry(bindings, kbId, c);
    if (entry instanceof Response) return entry;

    const bound = resolveBoundModels(bindings);
    const ebdProviderId = reembedOpts.ebdProviderId ?? bound.ebdProviderId;
    const ebdModel      = reembedOpts.ebdModel      ?? bound.ebdModel;
    if (!ebdProviderId || !ebdModel)
      return c.json({ error: 'no_embed_binding', message: '未配置 Embedding 模型，无法重建索引' }, 400);

    const task = entry.reembedQueue.enqueue({ ebdProviderId, ebdModel });
    return c.json({ taskId: task.id, status: task.status }, 202);
  });

  // GET /api/kb/reembed-tasks — 重建任务列表(含失败/取消历史, 与 ingest-tasks 同型)
  app.get('/reembed-tasks', async (c) => {
    const parsed = kbIdQuery.safeParse(c.req.query());
    const entry = await resolveEntry(bindings, parsed.success ? parsed.data.kbId : undefined, c);
    if (entry instanceof Response) return entry;
    return c.json(entry.reembedTasks.listActive());
  });

  // POST /api/kb/reembed-tasks/:taskId/cancel — 用户主动取消(运行中/排队中有效)
  app.post('/reembed-tasks/:taskId/cancel', async (c) => {
    const parsed = kbIdQuery.safeParse(c.req.query());
    const entry = await resolveEntry(bindings, parsed.success ? parsed.data.kbId : undefined, c);
    if (entry instanceof Response) return entry;
    const ok = entry.reembedQueue.cancel(c.req.param('taskId'));
    if (!ok) return c.json({ error: 'not_active_or_not_found' }, 404);
    return c.json({ ok: true });
  });

  // POST /api/kb/reembed-tasks/:taskId/retry — 失败/部分失败/取消后重试
  app.post('/reembed-tasks/:taskId/retry', async (c) => {
    const parsed = kbIdQuery.safeParse(c.req.query());
    const entry = await resolveEntry(bindings, parsed.success ? parsed.data.kbId : undefined, c);
    if (entry instanceof Response) return entry;
    const ok = entry.reembedQueue.retry(c.req.param('taskId'));
    if (!ok) return c.json({ error: 'not_failed_or_not_found' }, 404);
    return c.json({ ok: true });
  });

  // ── KB registry routes ────────────────────────────────────────────────────────

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

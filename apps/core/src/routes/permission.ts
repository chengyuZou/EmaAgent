import { Hono } from 'hono';
import { z } from 'zod';
import type { PermissionResponse } from '@ema-agent/permission';
import { filterPermissionPending } from '@ema-agent/turn';
import type { AppBindings } from '../wiring/index.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

const respondSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('allow') }),
  z.object({ action: z.literal('allow_session') }),
  z.object({
    action: z.literal('deny'),
    reason: z.string().optional(),
  }),
]);

// ── Route factory ────────────────────────────────────────────────────────────

/**
 * Frontend-facing endpoints for the permission prompt flow.
 *
 *   POST /api/permission/:promptId/respond
 *     body: PermissionResponse  → resolves the pending askPermission Promise
 *     404 if the promptId is unknown / expired / already resolved
 *
 *   POST /api/permission/:promptId/cancel
 *     dismisses the prompt (resolves as deny with reason='cancelled')
 *
 *   GET  /api/permission/pending
 *     returns recoverable in-flight prompt snapshots
 */
export function permissionRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  app.post('/:promptId/respond', async (c) => {
    const promptId = c.req.param('promptId');
    const parsed = respondSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }

    const response = parsed.data as PermissionResponse;
    const ok = bindings.interactionQueue.respondPermission(promptId, response);
    if (!ok) {
      return c.json({ error: 'not_found_or_expired', promptId }, 404);
    }
    return c.json({ ok: true });
  });

  app.post('/:promptId/cancel', (c) => {
    const promptId = c.req.param('promptId');
    const ok = bindings.interactionQueue.cancelActive(promptId, 'cancelled by user');
    if (!ok) {
      return c.json({ error: 'not_found_or_expired', promptId }, 404);
    }
    return c.json({ ok: true });
  });

  app.get('/pending', (c) => {
    // 统一队列混合快照按 kind 过滤出 Permission 部分。
    const prompts = filterPermissionPending(bindings.interactionQueue.listPending());
    return c.json({ count: prompts.length, prompts });
  });

  return app;
}

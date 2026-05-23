import { Hono } from 'hono';
import { z } from 'zod';
import { asSessionId } from '@ema-agent/contracts';
import type { AppBindings } from '../wiring.js';

// ── Schemas ─────────────────────────────────────────────────────────────────

const listSessionsSchema = z.object({
  limit:  z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.coerce.number().int().optional(),
});

const listMessagesSchema = z.object({
  before: z.coerce.number().int().optional(),
  limit:  z.coerce.number().int().min(1).max(200).default(100),
});

const patchSessionSchema = z.object({
  title:      z.string().min(1).max(200).optional(),
  pinned:     z.boolean().optional(),
  groupLabel: z.string().max(100).nullable().optional(),
});

const forkSchema = z.object({
  untilTurnId: z.string().optional(),
});

// ── Route factory ────────────────────────────────────────────────────────────

export function sessionsRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // ── GET /api/sessions — flat list (back-compat) ────────────────────────────
  app.get('/', (c) => {
    const query = listSessionsSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }
    const sessions = bindings.session.listSessions(query.data);
    return c.json(sessions);
  });

  // ── GET /api/sessions/grouped — sidebar-ready grouped listing ──────────────
  app.get('/grouped', (c) => {
    const result = bindings.session.listSessionsGrouped();
    return c.json(result);
  });

  // ── GET /api/sessions/:id/messages ─────────────────────────────────────────
  app.get('/:id/messages', (c) => {
    const query = listMessagesSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }

    const sessionId = asSessionId(c.req.param('id'));
    const messages = bindings.session.listMessages(sessionId, query.data);
    return c.json(messages);
  });

  // ── PUT /api/sessions/:id — partial update (title / pinned / groupLabel) ───
  app.put('/:id', async (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    const body = patchSessionSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }

    if (body.data.title !== undefined) {
      bindings.session.updateTitle(sessionId, body.data.title);
    }
    if (body.data.pinned === true) {
      bindings.session.pinSession(sessionId);
    } else if (body.data.pinned === false) {
      bindings.session.unpinSession(sessionId);
    }
    // groupLabel may be null (explicit "move out of group")
    if ('groupLabel' in body.data) {
      bindings.session.setSessionGroup(sessionId, body.data.groupLabel ?? null);
    }

    return c.json(bindings.session.getSession(sessionId));
  });

  // ── POST /api/sessions/:id/fork ────────────────────────────────────────────
  app.post('/:id/fork', async (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    const body = forkSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    const result = bindings.session.forkSession(sessionId);
    return c.json(result, 201);
  });

  // ── POST /api/sessions/:id/archive ─────────────────────────────────────────
  app.post('/:id/archive', (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    bindings.session.archiveSession(sessionId);
    return c.body(null, 204);
  });

  // ── POST /api/sessions/:id/unarchive ───────────────────────────────────────
  app.post('/:id/unarchive', (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    bindings.session.unarchiveSession(sessionId);
    return c.body(null, 204);
  });

  // ── DELETE /api/sessions/:id ───────────────────────────────────────────────
  app.delete('/:id', (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    bindings.session.deleteSession(sessionId);
    return c.body(null, 204);
  });

  return app;
}

import { Hono } from 'hono';
import { z } from 'zod';
import { asSessionId, asTurnId } from '@ema-agent/contracts';
import type { SessionWire, SessionMessagesResult, SessionsListResult, SessionsGroupedResult } from '@ema-agent/contracts';
import type { AppBindings } from '../wiring.js';

// ── Schemas ─────────────────────────────────────────────────────────────────

const listSessionsSchema = z.object({
  limit:  z.coerce.number().int().min(1).max(100).default(50),
  /**
   * Opaque cursor returned by the previous response. Internal format
   * (`"<pinned>.<updated_at>"`); the repo parses it and silently falls back
   * to "first page" if malformed.
   */
  cursor: z.string().min(1).max(64).optional(),
});

const listMessagesSchema = z.object({
  before: z.coerce.number().int().optional(),
  limit:  z.coerce.number().int().min(1).max(200).default(100),
});

const patchSessionSchema = z.object({
  title:          z.string().min(1).max(200).optional(),
  pinned:         z.boolean().optional(),
  groupLabel:     z.string().max(100).nullable().optional(),
  workspaceRoots: z.array(z.string().max(500)).max(20).optional(),
  lastMode:       z.enum(['chat', 'narrative', 'agent']).nullable().optional(),
  lastSubMode:    z.enum(['plan', 'debug', 'full']).nullable().optional(),
});

const forkSchema = z.object({
  untilTurnId: z.string().optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('session_not_found');
}

// ── Route factory ────────────────────────────────────────────────────────────

const createSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

export function sessionsRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // ── POST /api/sessions — explicit session creation ─────────────────────────
  // Used by the "New chat" button. Sessions are also created implicitly on the
  // first POST /api/turns when no sessionId is supplied.
  app.post('/', async (c) => {
    const body = createSessionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    const session = bindings.session.createSession({
      title: body.data.title,
    });
    // `satisfies` pins the JSON shape to the shared wire contract — if the
    // domain type drifts from what the frontend expects, this line fails the build.
    return c.json(session satisfies SessionWire, 201);
  });

  // ── GET /api/sessions — flat list (back-compat) ────────────────────────────
  app.get('/', (c) => {
    const query = listSessionsSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }
    const sessions = bindings.session.listSessions(query.data);
    return c.json(sessions satisfies SessionsListResult);
  });

  // ── GET /api/sessions/grouped — sidebar-ready grouped listing ──────────────
  app.get('/grouped', (c) => {
    const result = bindings.session.listSessionsGrouped();
    return c.json(result satisfies SessionsGroupedResult);
  });

  // ── GET /api/sessions/:id/messages ─────────────────────────────────────────
  app.get('/:id/messages', (c) => {
    const query = listMessagesSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }

    const sessionId = asSessionId(c.req.param('id'));
    const messages = bindings.session.listMessages(sessionId, query.data);
    // Turns ride along so the frontend can group messages by turnId and attach
    // per-turn usage / duration / replayable audio without a second request.
    const turns = bindings.session.listTurns(sessionId);
    return c.json({ messages, turns } satisfies SessionMessagesResult);
  });

  // ── PUT /api/sessions/:id — partial update (title / pinned / groupLabel) ───
  app.put('/:id', async (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    const body = patchSessionSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }

    try {
      bindings.session.patchSession(sessionId, {
        title:          body.data.title,
        pinned:         body.data.pinned,
        groupLabel:     'groupLabel' in body.data ? body.data.groupLabel ?? null : undefined,
        workspaceRoots: body.data.workspaceRoots,
        lastMode:       body.data.lastMode,
        lastSubMode:    body.data.lastSubMode,
      });
      if (body.data.workspaceRoots !== undefined) {
        // The cached CommandRunner baked the old roots into its sandbox
        // config — drop it so the next turn rebuilds against the new ones.
        bindings.invalidateSessionRuntime(sessionId);
      }
      return c.json(bindings.session.getSession(sessionId));
    } catch (err) {
      if (isNotFound(err)) return c.json({ error: 'session_not_found' }, 404);
      throw err;
    }
  });

  // ── POST /api/sessions/:id/fork ────────────────────────────────────────────
  app.post('/:id/fork', async (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    const body = forkSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    try {
      const result = bindings.session.forkSession(
        sessionId,
        body.data.untilTurnId ? asTurnId(body.data.untilTurnId) : undefined,
      );
      return c.json(result, 201);
    } catch (err) {
      if (isNotFound(err)) return c.json({ error: 'session_not_found' }, 404);
      throw err;
    }
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

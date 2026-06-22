import { Hono } from 'hono';
import { z } from 'zod';
import { asSessionId, asTurnId, asBranchId } from '@ema-agent/contracts';
import type {
  SessionWire,
  SessionMessagesResult,
  SessionsListResult,
  SessionsGroupedResult,
  SessionsSearchResult,
  MessageBlocks,
} from '@ema-agent/contracts';
import type { AppBindings } from '../wiring.js';

const TITLE_PROMPT = `Generate a very short title (3–6 words, no quotes) that captures the topic of the following message. Reply with only the title.\n\nMessage: `;
const TITLE_MAX_CHARS = 60;

// ── Schemas ─────────────────────────────────────────────────────────────────

const listSessionsSchema = z.object({
  limit:  z.coerce.number().int().min(1).max(100).default(50),
  /**
   * Opaque cursor returned by the previous response. Internal format
   * (`"<pinned>.<last_activity_at>"`); the repo parses it and silently falls back
   * to "first page" if malformed.
   */
  cursor: z.string().min(1).max(64).optional(),
});

const listMessagesSchema = z.object({
  before: z.coerce.number().int().optional(),
  limit:  z.coerce.number().int().min(1).max(200).default(100),
});

const searchSessionsSchema = z.object({
  q:     z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

const patchSessionSchema = z.object({
  title:          z.string().min(1).max(200).optional(),
  pinned:         z.boolean().optional(),
  groupLabel:     z.string().max(100).nullable().optional(),
  workspaceRoots: z.array(z.string().max(500)).max(20).optional(),
  lastMode:       z.enum(['chat', 'narrative', 'agent']).nullable().optional(),
});

const forkSchema = z.object({
  untilTurnId: z.string().optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('session_not_found');
}

function extractText(blocks: MessageBlocks): string {
  if (typeof blocks === 'string') return blocks;
  const part = (blocks as Array<{ type: string; text?: string }>).find((b) => b.type === 'text');
  return part?.text ?? '';
}

function truncateTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= TITLE_MAX_CHARS ? t : t.slice(0, TITLE_MAX_CHARS - 1) + '…';
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

  // ── GET /api/sessions/search?q=... — title/message search ────────────────
  app.get('/search', (c) => {
    const query = searchSessionsSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }
    const result = bindings.session.searchSessions({
      query: query.data.q,
      limit: query.data.limit,
    });
    return c.json(result satisfies SessionsSearchResult);
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

  // ── POST /api/sessions/:id/title — LLM-generated title (fire-and-forget) ───
  // Frontend calls this after the first turn of a new session completes.
  // Uses the 'title' binding; falls back to truncating the first user message.
  app.post('/:id/title', async (c) => {
    const sessionId = asSessionId(c.req.param('id'));

    try {
      const messages = bindings.session.listMessages(sessionId, { limit: 10 });
      const firstUser = messages.find((m) => m.role === 'user');
      if (!firstUser) return c.body(null, 204);

      const firstText = extractText(firstUser.blocks);
      if (!firstText) return c.body(null, 204);

      // Build title: try LLM first, fall back to truncation.
      let title: string;

      const binding    = bindings.modelBindings.get('title');
      const providerId = binding?.providerConfigId ?? bindings.llm.firstProviderId();
      const model      = binding?.model ?? (providerId ? bindings.llm.defaultModelFor(providerId) : undefined);

      if (providerId && model) {
        try {
          const result = await bindings.llm.complete({
            providerId,
            model,
            maxTokens: 32,
            temperature: 0,
            messages: [
              { role: 'user', content: [{ type: 'text', text: TITLE_PROMPT + firstText.slice(0, 400) }] },
            ],
          });
          const textBlock = result.blocks.find((b) => b.type === 'text');
          title = textBlock
            ? textBlock.text.trim().replace(/^["']|["']$/g, '').slice(0, TITLE_MAX_CHARS)
            : truncateTitle(firstText);
        } catch {
          title = truncateTitle(firstText);
        }
      } else {
        title = truncateTitle(firstText);
      }

      bindings.session.patchSession(sessionId, { title });
      return c.json({ title });
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

  // ── POST /api/sessions/:id/viewed — mark session as seen by user ───────────
  // Updates last_viewed_at so hasUnread resets for this session.
  app.post('/:id/viewed', (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    try {
      bindings.session.setViewedAt(sessionId);
    } catch { /* non-critical */ }
    return c.body(null, 204);
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

  // ── GET /api/sessions/:id/attachments ─────────────────────────────────────
  // Returns every turn_attachment for this session, ordered newest-first.
  app.get('/:id/attachments', (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    const attachments = bindings.attachmentStore.listBySession(sessionId);
    return c.json({ attachments });
  });

  // ── DELETE /api/sessions/:id ───────────────────────────────────────────────
  app.delete('/:id', (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    bindings.session.deleteSession(sessionId);
    return c.body(null, 204);
  });

  // ── GET /api/sessions/:id/branches ────────────────────────────────────────
  // Returns all branches with their fork-point turn's userInput and mode so
  // the frontend can label each node with the user's query text.
  app.get('/:id/branches', (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    try {
      const session  = bindings.session.getSession(sessionId);
      const branches = bindings.session.listBranches(sessionId);

      const nodes = branches.map((b) => {
        let forkUserInput = '';
        let forkTurnMode: string | null = null;
        if (b.forkFromTurnId) {
          const turn = bindings.session.getTurn(b.forkFromTurnId);
          if (turn) {
            forkUserInput = turn.userInput.slice(0, 30);
            forkTurnMode  = turn.mode;
          }
        }
        return {
          branchId:       b.id,
          parentBranchId: b.parentBranchId,
          forkFromTurnId: b.forkFromTurnId,
          forkUserInput,
          forkTurnMode,
          isActive: b.id === session.activeBranchId,
          createdAt: b.createdAt,
        };
      });

      return c.json({ sessionActiveBranchId: session.activeBranchId, branches: nodes });
    } catch (err) {
      if (isNotFound(err)) return c.json({ error: 'session_not_found' }, 404);
      throw err;
    }
  });

  // ── POST /api/sessions/:id/branches — fork at a turn ─────────────────────
  app.post('/:id/branches', async (c) => {
    const sessionId  = asSessionId(c.req.param('id'));
    const body       = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const fromTurnId = typeof body.fromTurnId === 'string' ? asTurnId(body.fromTurnId) : null;
    if (!fromTurnId) return c.json({ error: 'fromTurnId required' }, 400);
    try {
      const result = bindings.session.forkMessage({ sessionId, fromTurnId });
      return c.json(result, 201);
    } catch (err) {
      if (isNotFound(err)) return c.json({ error: 'session_not_found' }, 404);
      throw err;
    }
  });

  // ── PUT /api/sessions/:id/branches/active — switch active branch ──────────
  app.put('/:id/branches/active', async (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    const body      = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const branchId  = typeof body.branchId === 'string' ? asBranchId(body.branchId) : null;
    try {
      bindings.session.switchBranch({ sessionId, branchId });
      return c.body(null, 204);
    } catch (err) {
      if (isNotFound(err)) return c.json({ error: 'branch_not_found' }, 404);
      throw err;
    }
  });

  return app;
}

// Session 集合：创建、分组列表（侧栏唯一路径）、搜索、详情。
import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionStore } from '@ema-agent/session';

const createSessionBody = z.object({
  title: z.string().min(1).max(200).optional(),
  workspaceRoot: z.string().min(1).max(500).optional(),
  executionProfile: z.enum(['chat', 'work']).optional(),
  narrativePolicy: z.enum(['auto', 'always', 'off']).optional(),
});

const searchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export interface SessionCollectionRouteDeps {
  readonly session: Pick<
    SessionStore,
    'createSession' | 'getSession' | 'listSessionsGrouped' | 'searchSessions'
  >;
}

export function sessionCollectionRoute(deps: SessionCollectionRouteDeps): Hono {
  const app = new Hono();

  app.post('/', async context => {
    const parsed = createSessionBody.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    return context.json(deps.session.createSession(parsed.data), 201);
  });

  app.get('/', context => context.json(deps.session.listSessionsGrouped()));

  app.get('/search', context => {
    const query = searchQuery.safeParse(context.req.query());
    if (!query.success) {
      return context.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }
    return context.json(deps.session.searchSessions({
      query: query.data.q,
      limit: query.data.limit,
    }));
  });

  app.get('/:sessionId', context => {
    try {
      return context.json(deps.session.getSession(context.req.param('sessionId')));
    } catch {
      return context.json({ error: 'session_not_found' }, 404);
    }
  });

  return app;
}

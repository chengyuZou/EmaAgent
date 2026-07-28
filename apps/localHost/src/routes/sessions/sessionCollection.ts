// 处理 Session 集合的创建、分页、分组与搜索请求。
import { Hono } from 'hono';
import { z } from 'zod';
import type {
  SessionStore,
  SessionWire,
  SessionsGroupedResult,
  SessionsListResult,
  SessionsSearchResult,
} from '@ema-agent/session';

type SessionCollectionStore = Pick<
  SessionStore,
  'createSession' | 'listSessions' | 'listSessionsGrouped' | 'searchSessions'
>;

const createSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

const listSessionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** 结构由 Session 领域校验；HTTP 层只限制不透明游标的体积。 */
  cursor: z.string().min(1).max(256).optional(),
});

const searchSessionsSchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export function sessionCollectionRoute(session: SessionCollectionStore): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const body = createSessionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    const created = session.createSession({ title: body.data.title });
    return c.json(created satisfies SessionWire, 201);
  });

  app.get('/', (c) => {
    const query = listSessionsSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }
    try {
      return c.json(session.listSessions(query.data) satisfies SessionsListResult);
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid sessions cursor') {
        return c.json({ error: 'invalid_cursor' }, 400);
      }
      throw error;
    }
  });

  app.get('/grouped', (c) => (
    c.json(session.listSessionsGrouped() satisfies SessionsGroupedResult)
  ));

  app.get('/search', (c) => {
    const query = searchSessionsSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }
    return c.json(session.searchSessions({
      query: query.data.q,
      limit: query.data.limit,
    }) satisfies SessionsSearchResult);
  });

  return app;
}

// Session 集合：创建、分组列表（侧栏唯一路径）、搜索、详情。
import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionStore } from '@ema-agent/session';
import { jsonBody, queryValidator } from '../validate.js';

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

export const sessionCollectionRoute = (deps: SessionCollectionRouteDeps) =>
  new Hono()
    // 创建会话必须显式发 JSON（空对象即全默认）：契约一律声明，不吞真空 body。
    .post('/', jsonBody(createSessionBody), context =>
      context.json(deps.session.createSession(context.req.valid('json')), 201))
    .get('/', context => context.json(deps.session.listSessionsGrouped()))
    .get('/search', queryValidator(searchQuery), context => {
      const { q, limit } = context.req.valid('query');
      return context.json(deps.session.searchSessions({ query: q, limit }));
    })
    .get('/:sessionId', context => {
      try {
        return context.json(deps.session.getSession(context.req.param('sessionId')));
      } catch {
        return context.json({ error: 'session_not_found' }, 404);
      }
    });

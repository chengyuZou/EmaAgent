// Subagent 只读查询：按 Session 列表与单条详情；终态清理归 Session 生命周期，不开写端点。
import { Hono } from 'hono';
import { z } from 'zod';
import type { SubagentStore } from '@ema-agent/agent';
import { queryValidator } from '../validate.js';

export interface SubagentListRouteDeps {
  readonly subagents: SubagentStore;
}

const listQuery = z.object({
  sessionId: z.string().min(1),
  beforeUpdatedAt: z.coerce.number().int().optional(),
  beforeId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).refine(
  value => (value.beforeUpdatedAt === undefined) === (value.beforeId === undefined),
  { message: 'beforeUpdatedAt and beforeId must be provided together' }
);

export const subagentListRoute = (deps: SubagentListRouteDeps) =>
  new Hono()
    .get('/', queryValidator(listQuery), context => {
      const { sessionId, beforeUpdatedAt, beforeId, limit } = context.req.valid('query');
      const cursor = beforeUpdatedAt !== undefined && beforeId !== undefined
        ? { updatedAt: beforeUpdatedAt, id: beforeId }
        : undefined;
      return context.json(deps.subagents.listForSession(sessionId, cursor, limit));
    })
    .get('/:subagentId', context => {
      const subagent = deps.subagents.get(context.req.param('subagentId'));
      if (!subagent) {
        return context.json({ error: 'subagent_not_found' }, 404);
      }
      return context.json(subagent);
    });

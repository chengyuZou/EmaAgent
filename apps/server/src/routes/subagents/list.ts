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
});

export const subagentListRoute = (deps: SubagentListRouteDeps) =>
  new Hono()
    .get('/', queryValidator(listQuery), context => {
      const { sessionId } = context.req.valid('query');
      return context.json({
        items: deps.subagents.listForSession(sessionId),
        invocations: deps.subagents.listInvocationsForSession(sessionId),
      });
    })
    .get('/:subagentId', context => {
      const subagent = deps.subagents.getSummary(context.req.param('subagentId'));
      if (!subagent) return context.json({ error: 'subagent_not_found' }, 404);
      return context.json(subagent);
    });

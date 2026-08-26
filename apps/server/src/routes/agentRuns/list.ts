// AgentRun 只读查询：按 Session 列表与单条详情；终态清理归 Session 生命周期，不开写端点。
import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentRunStore } from '@ema-agent/agent';
import { queryValidator } from '../validate.js';

export interface AgentRunListRouteDeps {
  readonly agentRuns: Pick<AgentRunStore, 'listForSession' | 'get'>;
}

const listQuery = z.object({
  sessionId: z.string().min(1),
});

export const agentRunListRoute = (deps: AgentRunListRouteDeps) =>
  new Hono()
    .get('/', queryValidator(listQuery), context => {
      const { sessionId } = context.req.valid('query');
      return context.json({ items: deps.agentRuns.listForSession(sessionId) });
    })
    .get('/:agentRunId', context => {
      const run = deps.agentRuns.get(context.req.param('agentRunId'));
      if (!run) return context.json({ error: 'agent_run_not_found' }, 404);
      return context.json(run);
    });

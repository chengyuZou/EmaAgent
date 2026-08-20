// AgentRun 只读查询：按 Session 列表与单条详情；终态清理归 Session 生命周期，不开写端点。
import { Hono } from 'hono';
import type { AgentRunStore } from '@ema-agent/agent';

export interface AgentRunListRouteDeps {
  readonly agentRuns: Pick<AgentRunStore, 'listForSession' | 'get'>;
}

export function agentRunListRoute(deps: AgentRunListRouteDeps): Hono {
  const app = new Hono();

  app.get('/', context => {
    const sessionId = context.req.query('sessionId');
    if (!sessionId) return context.json({ error: 'session_id_required' }, 400);
    return context.json({ items: deps.agentRuns.listForSession(sessionId) });
  });

  app.get('/:agentRunId', context => {
    const run = deps.agentRuns.get(context.req.param('agentRunId'));
    if (!run) return context.json({ error: 'agent_run_not_found' }, 404);
    return context.json(run);
  });

  return app;
}

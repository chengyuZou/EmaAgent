// 提供 AgentRun 查询、执行记录读取与终态清理接口。

import { Hono } from 'hono';
import { z } from 'zod';
import { asAgentRunId, asSessionId } from '@ema-agent/ids';
import type { AppBindings } from '../wiring/index.js';

export function agentRunsRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);

    const status = c.req.query('status');
    let runs = bindings.agentRunStore.listForSession(asSessionId(sessionId));
    if (status) runs = runs.filter(run => run.status === status);

    return c.json({ runs });
  });

  app.post('/clear', async (c) => {
    const parsed = z.object({ sessionId: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'sessionId is required' }, 400);

    const deleted = bindings.agentRunStore.clearTerminalForSession(
      asSessionId(parsed.data.sessionId),
    );
    return c.json({ deleted });
  });

  app.get('/:agentRunId', (c) => {
    const run = bindings.agentRunStore.get(asAgentRunId(c.req.param('agentRunId')));
    if (!run) return c.json({ error: 'not_found' }, 404);
    return c.json({ run });
  });

  app.delete('/:agentRunId', (c) => {
    const agentRunId = asAgentRunId(c.req.param('agentRunId'));
    const run = bindings.agentRunStore.get(agentRunId);
    if (!run) return c.json({ error: 'not_found' }, 404);

    if (run.status === 'running') {
      bindings.agentRunStore.cancel(agentRunId, 'user_deleted');
    }
    bindings.agentRunStore.delete(agentRunId);
    return c.json({ ok: true });
  });

  app.get('/:agentRunId/messages', (c) => {
    const agentRunId = asAgentRunId(c.req.param('agentRunId'));
    if (!bindings.agentRunStore.get(agentRunId)) {
      return c.json({ error: 'not_found' }, 404);
    }

    const rows = bindings.agentRunMessages.listForRun(agentRunId);
    const messages = rows.map(row => ({
      id: row.id,
      agentRunId: row.agent_run_id,
      role: row.role,
      content: JSON.parse(row.content_json) as unknown,
      createdAt: row.created_at,
    }));
    return c.json({ messages });
  });

  return app;
}

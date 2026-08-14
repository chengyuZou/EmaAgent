// 提供 AgentRun 查询、执行记录读取与终态清理接口。

import { Hono } from 'hono';
import { z } from 'zod';
import { asAgentRunId, asSessionId } from '@ema-agent/ids';
import type {
  AgentRunStore,
  AgentRunTranscriptReader,
} from '@ema-agent/agent';

type AgentRunsRouteStore = Pick<
  AgentRunStore,
  'cancel' | 'clearTerminalForSession' | 'delete' | 'get' | 'listForSession'
>;

export function agentRunsRoute(
  agentRunStore: AgentRunsRouteStore,
  transcript: AgentRunTranscriptReader,
): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);

    const status = c.req.query('status');
    let runs = agentRunStore.listForSession(asSessionId(sessionId));
    if (status) runs = runs.filter(run => run.status === status);

    return c.json({ runs });
  });

  app.post('/clear', async (c) => {
    const parsed = z.object({ sessionId: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'sessionId is required' }, 400);

    const deleted = agentRunStore.clearTerminalForSession(
      asSessionId(parsed.data.sessionId),
    );
    return c.json({ deleted });
  });

  app.get('/:agentRunId', (c) => {
    const run = agentRunStore.get(asAgentRunId(c.req.param('agentRunId')));
    if (!run) return c.json({ error: 'not_found' }, 404);
    return c.json({ run });
  });

  app.delete('/:agentRunId', (c) => {
    const agentRunId = asAgentRunId(c.req.param('agentRunId'));
    const run = agentRunStore.get(agentRunId);
    if (!run) return c.json({ error: 'not_found' }, 404);

    if (run.status === 'running') {
      agentRunStore.cancel(agentRunId, 'user_deleted');
    }
    agentRunStore.delete(agentRunId);
    return c.json({ ok: true });
  });

  app.get('/:agentRunId/messages', (c) => {
    const agentRunId = asAgentRunId(c.req.param('agentRunId'));
    if (!agentRunStore.get(agentRunId)) {
      return c.json({ error: 'not_found' }, 404);
    }

    const messages = transcript.listForRun(agentRunId);
    return c.json({ messages });
  });

  return app;
}

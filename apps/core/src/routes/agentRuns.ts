// 提供 AgentRun 查询与清理接口，并在前端迁移期间保留旧 AgentTask 响应适配。

import { Hono } from 'hono';
import { z } from 'zod';
import { asAgentRunId, asSessionId } from '@ema-agent/ids';
import type { AgentRun } from '@ema-agent/agent';
import type { AppBindings } from '../wiring/index.js';

type RouteShape = 'agentRun' | 'legacyAgentTask';

export function agentRunsRoute(bindings: AppBindings): Hono {
  return buildAgentRunsRoute(bindings, 'agentRun');
}

/** 前端 TaskPanel 迁到 AgentRun 命名之前，只在 HTTP 边界转换旧字段。 */
export function legacyAgentTasksRoute(bindings: AppBindings): Hono {
  return buildAgentRunsRoute(bindings, 'legacyAgentTask');
}

function buildAgentRunsRoute(bindings: AppBindings, shape: RouteShape): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);

    const status = c.req.query('status');
    let runs = bindings.agentRunStore.listForSession(asSessionId(sessionId));
    if (status) runs = runs.filter(run => run.status === status);

    return shape === 'agentRun'
      ? c.json({ runs })
      : c.json({ tasks: runs.map(toLegacyAgentTask) });
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
    return shape === 'agentRun'
      ? c.json({ run })
      : c.json({ task: toLegacyAgentTask(run) });
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
      ...(shape === 'agentRun'
        ? { agentRunId: row.agent_run_id }
        : { taskId: row.agent_run_id }),
      role: row.role,
      content: JSON.parse(row.content_json) as unknown,
      createdAt: row.created_at,
    }));
    return c.json({ messages });
  });

  return app;
}

function toLegacyAgentTask(run: AgentRun) {
  return {
    id: run.id,
    sessionId: run.sessionId,
    turnId: null,
    parentId: run.parentTurnId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.iterations !== undefined ? { iterations: run.iterations } : {}),
    ...(run.inputTokens !== undefined ? { inputTokens: run.inputTokens } : {}),
    ...(run.outputTokens !== undefined ? { outputTokens: run.outputTokens } : {}),
  };
}

// 验证 AgentRun HTTP 边界直接返回执行身份与 transcript，不再投影成 AgentTask。
import { describe, expect, it, vi } from 'vitest';
import { asAgentRunId, asSessionId, asTurnId } from '@ema-agent/ids';
import type { AgentRun } from '@ema-agent/agent';
import type { AppBindings } from '../src/wiring/index.js';
import { agentRunsRoute } from '../src/routes/agentRuns.js';

const run: AgentRun = {
  id: asAgentRunId('agent-run-route'),
  sessionId: asSessionId('session-route'),
  parentTurnId: asTurnId('turn-route'),
  kind: 'subagent',
  purpose: '检查实现',
  status: 'completed',
  iterations: 2,
  toolCallCount: 3,
  version: 1,
  createdAt: 10,
  updatedAt: 20,
  completedAt: 20,
};

describe('AgentRun 路由', () => {
  it('按 Session 返回原生 AgentRun 快照', async () => {
    const listForSession = vi.fn(() => [run]);
    const app = agentRunsRoute({
      agentRunStore: { listForSession },
    } as unknown as AppBindings);

    const response = await app.request('/?sessionId=session-route');

    expect(response.status).toBe(200);
    expect(listForSession).toHaveBeenCalledWith(asSessionId('session-route'));
    expect(await response.json()).toEqual({
      runs: [expect.objectContaining({
        id: run.id,
        parentTurnId: run.parentTurnId,
        kind: 'subagent',
        purpose: '检查实现',
      })],
    });
  });

  it('执行记录使用 agentRunId，不再返回旧 taskId', async () => {
    const app = agentRunsRoute({
      agentRunStore: { get: vi.fn(() => run) },
      agentRunMessages: {
        listForRun: vi.fn(() => [{
          id: 'message-1',
          agent_run_id: run.id,
          role: 'assistant',
          content_json: JSON.stringify({ text: '完成' }),
          created_at: 21,
        }]),
      },
    } as unknown as AppBindings);

    const response = await app.request(`/${run.id}/messages`);
    const body = await response.json() as {
      messages: Array<{ agentRunId: string; taskId?: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.messages[0]?.agentRunId).toBe(run.id);
    expect(body.messages[0]?.taskId).toBeUndefined();
  });
});

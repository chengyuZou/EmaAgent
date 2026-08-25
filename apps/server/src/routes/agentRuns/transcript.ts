// AgentRun 内容流水回放：一次运行的文本/思考/工具调用/结果消息序列。
import { Hono } from 'hono';
import type { AgentRunMessagesStore, AgentRunStore } from '@ema-agent/agent';

export interface AgentRunTranscriptRouteDeps {
  readonly agentRuns: Pick<AgentRunStore, 'get'>;
  readonly agentRunMessages: Pick<AgentRunMessagesStore, 'listForRun'>;
}

export const agentRunTranscriptRoute = (deps: AgentRunTranscriptRouteDeps) =>
  new Hono()
    .get('/:agentRunId/messages', context => {
      const agentRunId = context.req.param('agentRunId');
      if (!deps.agentRuns.get(agentRunId)) {
        return context.json({ error: 'agent_run_not_found' }, 404);
      }
      return context.json({ items: deps.agentRunMessages.listForRun(agentRunId) });
    });

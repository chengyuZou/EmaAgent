// 提供根 Turn、单个 Tool Call 和单个子 AgentRun 的显式取消接口。

import type { Hono } from 'hono';
import { asTurnId } from '@ema-agent/ids';
import type { TurnExecutor } from '@ema-agent/turn-execution';

export type TurnControlExecutor = Pick<
  TurnExecutor,
  'abort' | 'abortAgentRun' | 'abortTool'
>;

export function registerTurnControlRoutes(
  app: Hono,
  executor: TurnControlExecutor,
): void {
  app.delete('/:turnId/subagents/:subagentId', (context) => {
    const turnId = asTurnId(context.req.param('turnId'));
    const subagentId = context.req.param('subagentId');
    executor.abortAgentRun(turnId as string, subagentId);
    return context.json({ ok: true });
  });

  app.delete('/:turnId/tools/:callId', (context) => {
    const turnId = asTurnId(context.req.param('turnId'));
    const callId = context.req.param('callId');
    const aborted = executor.abortTool(turnId as string, callId);
    if (!aborted) {
      return context.json({ ok: false, reason: 'not_found' }, 404);
    }
    return context.json({ ok: true });
  });

  app.post('/:turnId/abort', (context) => {
    const turnId = asTurnId(context.req.param('turnId'));
    return context.json({ ok: executor.abort(turnId) });
  });
}

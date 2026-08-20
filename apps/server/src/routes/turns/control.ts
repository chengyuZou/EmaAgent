// Turn 运行态控制：根 Turn/单 Tool/单子 Agent 的显式取消 + 执行日志审计查询。
import { Hono } from 'hono';
import type { ToolExecutionState } from '@ema-agent/tools';
import type { TurnExecutor, TurnStore } from '@ema-agent/turn';

export interface TurnControlRouteDeps {
  readonly executor: Pick<TurnExecutor, 'abort' | 'abortAgentRun' | 'abortTool'>;
  readonly turns: Pick<TurnStore, 'getTurn'>;
  readonly toolExecutionState: ToolExecutionState;
}

export function turnControlRoute(deps: TurnControlRouteDeps): Hono {
  const app = new Hono();

  app.post('/:turnId/abort', context => {
    const turnId = context.req.param('turnId');
    const turn = deps.turns.getTurn(turnId);
    if (!turn) return context.json({ error: 'turn_not_found' }, 404);
    return context.json({ ok: deps.executor.abort(turn.sessionId, turnId) });
  });

  app.delete('/:turnId/tools/:toolCallId', context => {
    const turnId = context.req.param('turnId');
    const toolCallId = context.req.param('toolCallId');
    if (!deps.executor.abortTool(turnId, toolCallId)) {
      return context.json({ ok: false, reason: 'not_found' }, 404);
    }
    return context.json({ ok: true });
  });

  app.delete('/:turnId/subagents/:agentRunId', context => {
    const turnId = context.req.param('turnId');
    const agentRunId = context.req.param('agentRunId');
    deps.executor.abortAgentRun(turnId, agentRunId);
    return context.json({ ok: true });
  });

  // 持久执行日志解释"Turn 失败但副作用已经发生"的情况。
  app.get('/:turnId/tool-executions', context => {
    const turnId = context.req.param('turnId');
    if (!deps.turns.getTurn(turnId)) {
      return context.json({ error: 'turn_not_found' }, 404);
    }
    return context.json({ executions: deps.toolExecutionState.listForTurn(turnId) });
  });

  return app;
}

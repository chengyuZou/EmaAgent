// 查询 Turn 的持久工具执行审计；运行态命令统一走 AgentChannel。
import { Hono } from 'hono';
import type { ToolExecutionState } from '@ema-agent/tools';
import type { TurnStore } from '@ema-agent/turn';

export interface TurnControlRouteDeps {
  readonly turns: Pick<TurnStore, 'getTurn'>;
  readonly toolExecutionState: ToolExecutionState;
}

export const turnControlRoute = (deps: TurnControlRouteDeps) =>
  new Hono()
    // 持久执行日志解释"Turn 失败但副作用已经发生"的情况。
    .get('/:turnId/tool-executions', context => {
      const turnId = context.req.param('turnId');
      if (!deps.turns.getTurn(turnId)) {
        return context.json({ error: 'turn_not_found' }, 404);
      }
      return context.json({ executions: deps.toolExecutionState.listForTurn(turnId) });
    });

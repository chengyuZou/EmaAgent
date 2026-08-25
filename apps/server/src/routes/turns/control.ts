// Turn 运行态控制：单 Tool/单子 Agent 的显式取消 + 执行日志审计查询。
// 整体停止不在此——那是 Session 级语义（POST /api/sessions/:id/abort，按坑位 kind 分发）。
import { Hono } from 'hono';
import type { ToolExecutionState } from '@ema-agent/tools';
import type { TurnExecutor, TurnStore } from '@ema-agent/turn';

export interface TurnControlRouteDeps {
  readonly executor: Pick<TurnExecutor, 'abortAgentRun' | 'abortTool'>;
  readonly turns: Pick<TurnStore, 'getTurn'>;
  readonly toolExecutionState: ToolExecutionState;
}

export const turnControlRoute = (deps: TurnControlRouteDeps) =>
  new Hono()
    .delete('/:turnId/tools/:toolCallId', context => {
      const turnId = context.req.param('turnId');
      const toolCallId = context.req.param('toolCallId');
      if (!deps.executor.abortTool(turnId, toolCallId)) {
        return context.json({ ok: false, reason: 'not_found' }, 404);
      }
      return context.json({ ok: true });
    })
    .delete('/:turnId/subagents/:agentRunId', context => {
      const turnId = context.req.param('turnId');
      const agentRunId = context.req.param('agentRunId');
      deps.executor.abortAgentRun(turnId, agentRunId);
      return context.json({ ok: true });
    })
    // 持久执行日志解释"Turn 失败但副作用已经发生"的情况。
    .get('/:turnId/tool-executions', context => {
      const turnId = context.req.param('turnId');
      if (!deps.turns.getTurn(turnId)) {
        return context.json({ error: 'turn_not_found' }, 404);
      }
      return context.json({ executions: deps.toolExecutionState.listForTurn(turnId) });
    });

// 提供 Turn 工具执行审计查询，取消操作仍统一由 Turn 控制路由处理。

import type { Hono } from 'hono';
import { asTurnId } from '@ema-agent/ids';
import type { SessionStore } from '@ema-agent/session';
import type { ToolExecutionJournalReader } from '@ema-agent/tools';

export interface TurnToolsRouteBindings {
  readonly session: Pick<SessionStore, 'getTurn'>;
  readonly toolExecutionJournal: ToolExecutionJournalReader;
}

export function registerTurnToolsRoute(
  app: Hono,
  bindings: TurnToolsRouteBindings,
): void {
  // 持久执行日志可以解释“Turn 失败但副作用已经发生”的情况。
  app.get('/:turnId/tool-executions', (context) => {
    const turnId = asTurnId(context.req.param('turnId'));
    if (!bindings.session.getTurn(turnId)) {
      return context.json({ error: 'turn_not_found' }, 404);
    }
    return context.json({
      executions: bindings.toolExecutionJournal.listForTurn(turnId),
    });
  });
}

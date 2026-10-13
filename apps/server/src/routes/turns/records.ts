import { Hono } from 'hono';
import { z } from 'zod';
import type { AssistantBlock } from '@ema-agent/llm';
import type { ToolResult } from '@ema-agent/tools';
import type { MessagesRepo, SubagentMessagesRepo, ToolExecutionsRepo } from '@ema-agent/storage';
import type { TurnStore } from '@ema-agent/turn';
import { queryValidator } from '../validate.js';

const pageQuery = z.object({
  beforeCreatedAt: z.coerce.number().int().optional(),
  beforeId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const turnListQuery = pageQuery.extend({ sessionId: z.string().min(1) }).refine(
  input => (input.beforeCreatedAt === undefined) === (input.beforeId === undefined),
  { message: 'turn_cursor_incomplete' },
);
const toolListQuery = pageQuery.refine(
  input => (input.beforeCreatedAt === undefined) === (input.beforeId === undefined),
  { message: 'tool_cursor_incomplete' },
);

export interface TurnRecordsRouteDeps {
  readonly turns: Pick<TurnStore, 'getTurn' | 'listSummaries'>;
  readonly toolExecutions: Pick<ToolExecutionsRepo, 'listForTurnPage' | 'findByCallId'>;
  readonly messages: Pick<MessagesRepo, 'findToolBlocks'>;
  readonly subagentMessages: Pick<SubagentMessagesRepo, 'findToolBlocks'>;
}

export const turnRecordsRoute = (deps: TurnRecordsRouteDeps) =>
  new Hono()
    .get('/', queryValidator(turnListQuery), context => {
      const { sessionId, beforeCreatedAt, beforeId, limit } = context.req.valid('query');
      const cursor = beforeCreatedAt === undefined || beforeId === undefined
        ? undefined
        : { createdAt: beforeCreatedAt, id: beforeId };
      return context.json(deps.turns.listSummaries(sessionId, cursor, limit));
    })
    .get('/:turnId', context => {
      const turn = deps.turns.getTurn(context.req.param('turnId'));
      if (!turn) {
        return context.json({ error: 'turn_not_found' }, 404);
      }
      return context.json({ turn });
    })
    .get('/:turnId/tool-executions', queryValidator(toolListQuery), context => {
      const turnId = context.req.param('turnId');
      if (!deps.turns.getTurn(turnId)) {
        return context.json({ error: 'turn_not_found' }, 404);
      }
      const { beforeCreatedAt, beforeId, limit } = context.req.valid('query');
      const cursor = beforeCreatedAt === undefined || beforeId === undefined
        ? undefined
        : { createdAt: beforeCreatedAt, id: beforeId };
      return context.json(deps.toolExecutions.listForTurnPage(turnId, cursor, limit));
    })
    .get('/:turnId/tool-executions/:callId', context => {
      const execution = deps.toolExecutions.findByCallId(context.req.param('callId'));
      if (!execution || execution.turnId !== context.req.param('turnId')) {
        return context.json({ error: 'tool_execution_not_found' }, 404);
      }
      const blocks = execution.subagentId
        ? deps.subagentMessages.findToolBlocks(execution.subagentId, execution.callId)
        : deps.messages.findToolBlocks(execution.turnId, execution.callId);
      // 消息块由 Agent 写入, 这里保留 ToolResult.data 供现有 Tool UI 使用, 不重新拼结果.
      const block = blocks.callJson
        ? JSON.parse(blocks.callJson) as Extract<AssistantBlock, { type: 'tool_use' }>
        : undefined;
      const result = blocks.resultJson ? JSON.parse(blocks.resultJson) as ToolResult : undefined;
      return context.json({ execution, block, result });
    });

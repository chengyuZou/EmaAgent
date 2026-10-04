import { Hono } from 'hono';
import type { SubagentMessagesStore, SubagentStore } from '@ema-agent/agent';
import { z } from 'zod';
import { queryValidator } from '../validate.js';

const messagesQuery = z.object({
  beforeCreatedAt: z.coerce.number().int().optional(),
  beforeId: z.string().min(1).optional(),
  afterCreatedAt: z.coerce.number().int().optional(),
  afterId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).refine(
  value => (value.beforeCreatedAt === undefined) === (value.beforeId === undefined),
  { message: 'beforeCreatedAt and beforeId must be provided together' }
).refine(
  value => (value.afterCreatedAt === undefined) === (value.afterId === undefined),
  { message: 'afterCreatedAt and afterId must be provided together' }
).refine(
  value => value.beforeId === undefined || value.afterId === undefined,
  { message: 'message_cursor_direction_conflict' }
);

export const subagentMessagesRoute = (deps: {
  readonly subagents: SubagentStore;
  readonly subagentMessages: SubagentMessagesStore;
}) =>
  new Hono()
    .get('/:subagentId/messages', queryValidator(messagesQuery), context => {
      const subagentId = context.req.param('subagentId');
      if (!deps.subagents.get(subagentId)) {
        return context.json({ error: 'subagent_not_found' }, 404);
      }
      const { beforeCreatedAt, beforeId, afterCreatedAt, afterId, limit } = context.req.valid('query');

      let cursor: { createdAt: number; id: string } | undefined;
      if (beforeCreatedAt !== undefined && beforeId !== undefined) {
        cursor = { createdAt: beforeCreatedAt, id: beforeId };
      } else if (afterCreatedAt !== undefined && afterId !== undefined) {
        cursor = { createdAt: afterCreatedAt, id: afterId };
      }

      return context.json(deps.subagentMessages.listWindow(subagentId, cursor, afterId ? 'after' : 'before', limit));
    });

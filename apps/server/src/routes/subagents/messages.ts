import { Hono } from 'hono';
import type { SubagentMessagesStore, SubagentStore } from '@ema-agent/agent';
import { z } from 'zod';
import { queryValidator } from '../validate.js';

const messagesQuery = z.object({
  beforeCreatedAt: z.coerce.number().int().optional(),
  beforeId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).refine(value => (value.beforeCreatedAt === undefined) === (value.beforeId === undefined), {
  message: 'beforeCreatedAt and beforeId must be provided together',
});

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
      const { beforeCreatedAt, beforeId, limit } = context.req.valid('query');
      const cursor = beforeCreatedAt !== undefined && beforeId !== undefined
        ? { createdAt: beforeCreatedAt, id: beforeId }
        : undefined;
      return context.json(deps.subagentMessages.listPage(subagentId, cursor, limit));
    });

import { Hono } from 'hono';
import type { SubagentMessagesStore, SubagentStore } from '@ema-agent/agent';
import { z } from 'zod';
import { queryValidator } from '../validate.js';

const messagesQuery = z.object({
  beforeSequence: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const subagentMessagesRoute = (deps: {
  readonly subagents: SubagentStore;
  readonly subagentMessages: SubagentMessagesStore;
}) =>
  new Hono()
    .get('/:subagentId/messages', queryValidator(messagesQuery), context => {
      const subagentId = context.req.param('subagentId');
      if (!deps.subagents.getSummary(subagentId)) {
        return context.json({ error: 'subagent_not_found' }, 404);
      }
      const { beforeSequence, limit } = context.req.valid('query');
      return context.json(deps.subagentMessages.listPage(subagentId, beforeSequence, limit));
    });

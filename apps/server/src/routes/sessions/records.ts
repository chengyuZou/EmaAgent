import { Hono } from 'hono';
import { z } from 'zod';
import type { MessagesRepo, SessionStatsRepo, SpeechOutputsRepo } from '@ema-agent/storage';
import { queryValidator } from '../validate.js';

const pageQuery = z.object({
  beforeCreatedAt: z.coerce.number().int().optional(),
  beforeId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const messagesQuery = pageQuery.extend({
  order: z.enum(['asc', 'desc']).default('asc'),
  turnId: z.string().min(1).optional(),
}).refine(
  input => (input.beforeCreatedAt === undefined) === (input.beforeId === undefined),
  { message: 'message_cursor_incomplete' },
);

const audioQuery = pageQuery.refine(
  input => (input.beforeCreatedAt === undefined) === (input.beforeId === undefined),
  { message: 'audio_cursor_incomplete' },
);

export interface SessionRecordsRouteDeps {
  readonly sessionStats: Pick<SessionStatsRepo, 'listSummaries'>;
  readonly messages: Pick<MessagesRepo, 'listHeadersPage' | 'findById'>;
  readonly speechOutputs: Pick<SpeechOutputsRepo, 'listPage'>;
}

export const sessionRecordsRoute = (deps: SessionRecordsRouteDeps) =>
  new Hono()
    .get('/summaries', context => context.json({ sessions: deps.sessionStats.listSummaries() }))
    .get('/:sessionId/raw-messages', queryValidator(messagesQuery), context => {
      const { beforeCreatedAt, beforeId, order, limit, turnId } = context.req.valid('query');
      const cursor = beforeCreatedAt === undefined || beforeId === undefined
        ? undefined
        : { createdAt: beforeCreatedAt, id: beforeId };
      const page = deps.messages.listHeadersPage(context.req.param('sessionId'), cursor, limit, order, turnId);
      return context.json({
        messages: page.rows.map(message => ({
          id: message.id,
          role: message.role,
          kind: message.kind,
          createdAt: message.created_at,
        })),
        nextCursor: page.nextCursor,
      });
    })
    .get('/:sessionId/raw-messages/:messageId', context => {
      const message = deps.messages.findById(context.req.param('messageId'));
      if (!message || message.session_id !== context.req.param('sessionId')) {
        return context.json({ error: 'message_not_found' }, 404);
      }
      return context.json({ blocksJson: message.blocks_json });
    })
    .get('/:sessionId/audio', queryValidator(audioQuery), context => {
      const { beforeCreatedAt, beforeId, limit } = context.req.valid('query');
      const cursor = beforeCreatedAt === undefined || beforeId === undefined
        ? undefined
        : { createdAt: beforeCreatedAt, id: beforeId };
      return context.json(deps.speechOutputs.listPage(context.req.param('sessionId'), cursor, limit));
    });

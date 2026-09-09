// Session 历史读取：Message 正文分页、Message 锚点窗口、Turn 导航索引与终态收口。
import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionStore } from '@ema-agent/session';
import type { TurnStore } from '@ema-agent/turn';
import { queryValidator } from '../validate.js';

const listMessagesQuery = z.object({
  before: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const turnIndexQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const messagesAroundQuery = z.object({
  anchorMessageId: z.string().min(1),
  before: z.coerce.number().int().min(0).max(100).default(20),
  after: z.coerce.number().int().min(0).max(100).default(30),
}).refine(
  value => value.before + value.after <= 100,
  { message: 'message_window_too_large' },
);

export interface SessionHistoryRouteDeps {
  readonly session: Pick<SessionStore, 'listMessages' | 'listMessagesAround' | 'loadMessagesForTurn'>;
  readonly turns: Pick<TurnStore, 'getTurn' | 'listTurnIndex'>;
  /** Session 被打开(拉历史)时触发一次 fire-and-forget 的附件残留清扫。 */
  readonly onSessionOpened?: (sessionId: string) => void;
}

export const sessionHistoryRoute = (deps: SessionHistoryRouteDeps) =>
  new Hono()
    .get('/:sessionId/messages/around', queryValidator(messagesAroundQuery), context => {
      try {
        return context.json(deps.session.listMessagesAround(
          context.req.param('sessionId'),
          context.req.valid('query'),
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('message_not_found') || message.includes('session_ownership_violation')) {
          return context.json({ error: 'message_not_found' }, 404);
        }
        throw error;
      }
    })
    .get('/:sessionId/messages', queryValidator(listMessagesQuery), context => {
      const sessionId = context.req.param('sessionId');
      deps.onSessionOpened?.(sessionId);
      return context.json(deps.session.listMessages(sessionId, context.req.valid('query')));
    })
    .get('/:sessionId/turn-index', queryValidator(turnIndexQuery), context => {
      return context.json(deps.turns.listTurnIndex(context.req.param('sessionId'), context.req.valid('query')));
    })
    .get('/:sessionId/turns/:turnId/messages', context => {
      const sessionId = context.req.param('sessionId');
      const turn = deps.turns.getTurn(context.req.param('turnId'));
      if (!turn || turn.sessionId !== sessionId) {
        return context.json({ error: 'turn_not_found' }, 404);
      }
      return context.json({ messages: deps.session.loadMessagesForTurn(turn.id) });
    });

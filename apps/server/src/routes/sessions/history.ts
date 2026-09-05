// Session 历史读取：消息分页、Turn 索引与锚点窗口（窗口拆半：turns 归 TurnStore，消息归 SessionStore）。
// 附件信息已经在消息块里(path/name/preview),不再按 Turn 拼接账本行。
import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionStore } from '@ema-agent/session';
import type { TurnStore } from '@ema-agent/turn';
import { queryValidator } from '../validate.js';

const listMessagesQuery = z.object({
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const turnIndexQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const messageWindowQuery = z.object({
  anchorTurnId: z.string().min(1),
  beforeTurns: z.coerce.number().int().min(0).max(25).default(8),
  afterTurns: z.coerce.number().int().min(0).max(25).default(12),
}).refine(
  value => value.beforeTurns + value.afterTurns <= 40,
  { message: 'message_window_too_large' },
);

export interface SessionHistoryRouteDeps {
  readonly session: Pick<SessionStore, 'listMessages' | 'listMessagesForTurns'>;
  readonly turns: Pick<TurnStore, 'listTurns' | 'listTurnIndex' | 'listTurnWindow'>;
  /** Session 被打开(拉历史)时触发一次 fire-and-forget 的附件残留清扫。 */
  readonly onSessionOpened?: (sessionId: string) => void;
}

export const sessionHistoryRoute = (deps: SessionHistoryRouteDeps) =>
  new Hono()
    .get('/:sessionId/messages', queryValidator(listMessagesQuery), context => {
      const sessionId = context.req.param('sessionId');
      deps.onSessionOpened?.(sessionId);
      return context.json({
        messages: deps.session.listMessages(sessionId, context.req.valid('query')),
        turns: deps.turns.listTurns(sessionId),
      });
    })
    .get('/:sessionId/turn-index', queryValidator(turnIndexQuery), context => {
      return context.json(deps.turns.listTurnIndex(context.req.param('sessionId'), context.req.valid('query')));
    })
    .get('/:sessionId/messages/window', queryValidator(messageWindowQuery), context => {
      const sessionId = context.req.param('sessionId');
      const window = deps.turns.listTurnWindow(sessionId, context.req.valid('query'));
      const turnIds = window.turns.map(turn => turn.id);
      return context.json({
        ...window,
        messages: deps.session.listMessagesForTurns(sessionId, turnIds),
      });
    });

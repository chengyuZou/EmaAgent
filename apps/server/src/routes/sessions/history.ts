// Session 历史读取：消息分页、Turn 索引与锚点窗口（窗口拆半：turns 归 TurnStore，消息归 SessionStore）。
import { Hono } from 'hono';
import { z } from 'zod';
import type { Attachment, AttachmentStore } from '@ema-agent/attachments';
import type { Message, SessionStore } from '@ema-agent/session';
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

/** 附件展示投影：路径不进 wire，内容经 /attachments/:id/content 端点读取。 */
interface AttachmentWire {
  readonly id: string;
  readonly kind: Attachment['kind'];
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

function toAttachmentWire(attachment: Attachment): AttachmentWire {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    byteSize: attachment.kind === 'image' ? attachment.imageByteSize : attachment.byteSize,
  };
}

export interface SessionHistoryRouteDeps {
  readonly session: Pick<SessionStore, 'listMessages' | 'listMessagesForTurns'>;
  readonly turns: Pick<TurnStore, 'listTurns' | 'listTurnIndex' | 'listTurnWindow'>;
  readonly attachments: Pick<AttachmentStore, 'listByTurn'>;
}

export const sessionHistoryRoute = (deps: SessionHistoryRouteDeps) => {
  const withAttachments = (messages: readonly Message[]) =>
    messages.map(message => {
      if (message.role !== 'user' || !message.turnId) return message;
      const rows = deps.attachments.listByTurn(message.turnId);
      if (rows.length === 0) return message;
      return { ...message, attachments: rows.map(toAttachmentWire) };
    });

  return new Hono()
    .get('/:sessionId/messages', queryValidator(listMessagesQuery), context => {
      const sessionId = context.req.param('sessionId');
      return context.json({
        messages: withAttachments(deps.session.listMessages(sessionId, context.req.valid('query'))),
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
        messages: withAttachments(deps.session.listMessagesForTurns(sessionId, turnIds)),
      });
    });
}

// 提供长 Session 的轻量 Turn 索引、局部消息窗口与兼容历史读取。
import { Hono } from 'hono';
import { z } from 'zod';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import type { AttachmentStorePort, FileAccessFacade } from '@ema-agent/attachment';
import type {
  SessionMessageWindowWire,
  SessionMessagesResult,
  SessionStore,
  TurnIndexPageWire,
} from '@ema-agent/session';
import { enrichStoredAttachments } from './attachmentProjection.js';

type SessionHistoryStore = Pick<
  SessionStore,
  'listTurnIndex' | 'listMessageWindow' | 'listMessages' | 'listTurns'
>;

const listMessagesSchema = z.object({
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const listTurnIndexSchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const messageWindowSchema = z.object({
  anchorTurnId: z.string().min(1).max(200),
  beforeTurns: z.coerce.number().int().min(0).max(25).default(8),
  afterTurns: z.coerce.number().int().min(0).max(25).default(12),
}).refine(
  (value) => value.beforeTurns + value.afterTurns <= 40,
  { message: 'message_window_too_large' },
);

export function sessionHistoryRoute(
  session: SessionHistoryStore,
  attachmentStore: Pick<AttachmentStorePort, 'listByTurn'>,
  fileAccess: Pick<FileAccessFacade, 'issue'>,
): Hono {
  const app = new Hono();
  const projection = { attachmentStore, fileAccess };

  app.get('/:id/turn-index', (c) => {
    const query = listTurnIndexSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }
    try {
      return c.json(session.listTurnIndex(
        asSessionId(c.req.param('id')),
        query.data,
      ) satisfies TurnIndexPageWire);
    } catch (error) {
      if (isSessionNotFound(error)) return c.json({ error: 'session_not_found' }, 404);
      if (error instanceof Error && error.message === 'Invalid turn index cursor') {
        return c.json({ error: 'invalid_cursor' }, 400);
      }
      throw error;
    }
  });

  app.get('/:id/messages/window', (c) => {
    const query = messageWindowSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }
    try {
      const window = session.listMessageWindow(asSessionId(c.req.param('id')), {
        anchorTurnId: asTurnId(query.data.anchorTurnId),
        beforeTurns: query.data.beforeTurns,
        afterTurns: query.data.afterTurns,
      });
      return c.json({
        ...window,
        messages: enrichStoredAttachments(projection, window.messages),
      } satisfies SessionMessageWindowWire);
    } catch (error) {
      if (isSessionNotFound(error)) return c.json({ error: 'session_not_found' }, 404);
      if (
        errorStartsWith(error, 'turn_not_found')
        || errorStartsWith(error, 'session_ownership_violation')
      ) {
        return c.json({ error: 'turn_not_found' }, 404);
      }
      throw error;
    }
  });

  app.get('/:id/messages', (c) => {
    const query = listMessagesSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }
    const sessionId = asSessionId(c.req.param('id'));
    return c.json({
      messages: enrichStoredAttachments(
        projection,
        session.listMessages(sessionId, query.data),
      ),
      turns: session.listTurns(sessionId),
    } satisfies SessionMessagesResult);
  });

  return app;
}

function isSessionNotFound(error: unknown): boolean {
  return errorStartsWith(error, 'session_not_found');
}

function errorStartsWith(error: unknown, prefix: string): boolean {
  return error instanceof Error && error.message.startsWith(prefix);
}

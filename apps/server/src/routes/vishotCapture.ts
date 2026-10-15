import { Hono } from 'hono';
import { z } from 'zod';
import type { VishotCapture } from '@ema-agent/vishot-capture';
import type { SessionStore } from '@ema-agent/session';
import { jsonBody } from './validate.js';

export const vishotCaptureRoute = (
  capture: Pick<VishotCapture, 'setSessionId'>,
  sessions: Pick<SessionStore, 'sessionExists'>,
) => new Hono().put('/session', jsonBody(z.object({ sessionId: z.uuid().nullable() })), context => {
  const { sessionId } = context.req.valid('json');
  if (sessionId !== null && !sessions.sessionExists(sessionId)) {
    return context.json({ error: 'session_not_found' }, 404);
  }
  capture.setSessionId(sessionId);
  return context.json({ ok: true });
});

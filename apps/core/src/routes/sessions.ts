import { Hono } from 'hono';
import { z } from 'zod';
import { asSessionId } from '@ema-agent/contracts';
import type { AppBindings } from '../wiring.js';

const listSessionsSchema = z.object({
  limit:  z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const listMessagesSchema = z.object({
  limit:  z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export function sessionsRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // GET /api/sessions
  app.get('/', (c) => {
    const query = listSessionsSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }
    const sessions = bindings.session.listSessions(query.data);
    return c.json(sessions);
  });

  // GET /api/sessions/:id/messages
  app.get('/:id/messages', (c) => {
    const query = listMessagesSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }

    const sessionId = asSessionId(c.req.param('id'));
    const messages = bindings.session.listMessages(sessionId, query.data);
    return c.json(messages);
  });

  return app;
}

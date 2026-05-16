import { Hono } from 'hono';
import { z } from 'zod';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { TurnEventStore } from '../sse/event-store.js';
import { encodeEvent, encodePing } from '../sse/writer.js';
import type { AppBindings } from '../wiring.js';
import type { TurnId } from '@ema-agent/contracts';
import { asTurnId } from '@ema-agent/contracts';

// ── UTF-8 safe body decoder ───────────────────────────────────────────────────

async function safeJsonBody(c: import('hono').Context): Promise<unknown> {
  const buf = await c.req.raw.arrayBuffer();

  const bytes = new Uint8Array(buf);
  if (bytes.length === 0) return null;

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!utf8.includes('\uFFFD')) return JSON.parse(utf8);

  try {
    const gbk = new TextDecoder('gbk', { fatal: false}).decode(bytes);
    return JSON.parse(gbk);
  } catch {
    return JSON.parse(utf8);
  }
}

const contentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'),       text: z.string() }),
  z.object({ type: z.literal('image_url'),  url: z.string() }),
  z.object({ type: z.literal('image_data'), data: z.string(), mimeType: z.string() }),
  z.object({ type: z.literal('audio_data'), data: z.string(), mimeType: z.string() }),
  z.object({ type: z.literal('file_data'),  data: z.string(), mimeType: z.string(), filename: z.string().optional() }),
  z.object({ type: z.literal('file_url'),   url: z.string(),  mimeType: z.string(), filename: z.string().optional() }),
]);

const turnBodySchema = z.object({
  sessionId: z.string().optional(),
  mode: z.enum(['chat', 'narrative', 'agent']).default('chat'),
  subMode: z.enum(['plan', 'debug', 'full']).optional(),
  userInput: z.string().optional(),
  contentParts: z.array(contentPartSchema).optional(),
  model: z.string().optional(),
}).refine(
  (data) => data.userInput || (data.contentParts && data.contentParts.length > 0),
  { message: 'either userInput or contentParts is required' },
);

// ── Route factory ─────────────────────────────────────────────────────────────

export function turnsRoute(bindings: AppBindings): Hono {
  const app = new Hono();
  const orchestrator = new Orchestrator(bindings);
  const eventStore = new TurnEventStore(60_000);
  // Evict completed / cancelled turns every 30 s to prevent unbounded memory growth.
  setInterval(() => eventStore.evictExpired(), 30_000).unref?.();

  // ── POST /api/turns ────────────────────────────────────────────────────────
  app.post('/', async (c) => {
    const parsed = turnBodySchema.safeParse(await safeJsonBody(c).catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }

    const { sessionId, mode, subMode, userInput, contentParts, model } = parsed.data;

    const effectiveSessionId = sessionId
      ?? bindings.session.createSession().id;

    const { turnId, events } = orchestrator.run({
      sessionId: effectiveSessionId,
      mode: mode,
      subMode: subMode,
      userInput: userInput ?? '',
      contentParts: contentParts,
      model: model,
    });

    // ── Fan-out: push every event into TurnEventStore for replay ──────────
    (async () => {
      for await (const event of events) {
        eventStore.push(turnId, event);
      }
    })().catch((err) => {
      console.error('[turns] event fan-out error', err);
    });

    return c.json({ turnId, sessionId: effectiveSessionId });
  });

  // ── GET /api/turns/:turnId/events (SSE) ────────────────────────────────────
  app.get('/:turnId/events', (c) => {
    const turnId = asTurnId(c.req.param('turnId'));
    const lastEventId = parseInt(c.req.query('lastEventId') ?? '0', 10) || 0;

    // Replay missed events from the store
    const missed = eventStore.replay(turnId, lastEventId);
    const isDone = eventStore.isDone(turnId);

    let eventIndex = lastEventId + missed.length;

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          let closed = false;

          // ── Send missed events immediately ──────────────────────────────
          for (const event of missed) {
            if (closed) break;
            controller.enqueue(encoder.encode(encodeEvent(event)));
          }

          // If the turn is already done, close immediately
          if (isDone) {
            controller.close();
            eventStore.clear(turnId);
            return;
          }

          // ── Heartbeat ───────────────────────────────────────────────────
          heartbeat = setInterval(() => {
            if (!closed) {
              try { controller.enqueue(encoder.encode(encodePing())); } catch { /* ignore */ }
            }
          }, 15_000);

          // ── Poll TurnEventStore for new events ──────────────────────────
          poll = setInterval(() => {
            if (closed) return;
            const newEvents = eventStore.replay(turnId, eventIndex);
            for (const event of newEvents) {
              controller.enqueue(encoder.encode(encodeEvent(event)));
            }
            eventIndex += newEvents.length;

            if (eventStore.isDone(turnId)) {
              closed = true;
              if (heartbeat) clearInterval(heartbeat);
              if (poll) clearInterval(poll);
              try { controller.close(); } catch { /* ignore */ }
              eventStore.clear(turnId);
            }
          }, 200); // poll every 200ms
        },
        cancel() {
          // Client disconnected — mark turn as cancelled so further push() calls
          // are dropped. Do NOT call clear() here: that would erase the cancelled
          // entry and let the background fan-out IIFE silently re-create the store
          // entry with no reader on the other end.
          eventStore.cancel(turnId);
          if (heartbeat) clearInterval(heartbeat);
          if (poll) clearInterval(poll);
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      },
    );
  });

  return app;
}
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { TurnEventHub } from '../sse/event-hub.js';
import { TurnEventStore } from '../sse/event-store.js';
import { encodeEvent, encodePing } from '../sse/writer.js';
import type { AppBindings } from '../wiring.js';
import type { EmaStreamEvent, TurnId } from '@ema-agent/contracts';
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
  ttsEnabled: z.boolean().optional(),
}).refine(
  (data) => data.userInput || (data.contentParts && data.contentParts.length > 0),
  { message: 'either userInput or contentParts is required' },
);

function isTerminalTurnEvent(event: EmaStreamEvent): boolean {
  return (
    event.type === 'turn_aborted' ||
    event.type === 'turn_failed' ||
    event.type === 'turn_completed'
  );
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function turnsRoute(bindings: AppBindings): Hono {
  const app = new Hono();
  const eventStore = new TurnEventStore(60_000);
  const eventHub = new TurnEventHub();
  const orchestrator = new Orchestrator(bindings, {
    onAudioFinalized: (turnId, audioPath) => {
      if (audioPath) eventStore.evictAudioChunks(turnId);
    },
  });
  // Evict completed / cancelled turns every 30 s to prevent unbounded memory growth.
  setInterval(() => eventStore.evictExpired(), 30_000).unref?.();

  // ── POST /api/turns ────────────────────────────────────────────────────────
  app.post('/', async (c) => {
    const parsed = turnBodySchema.safeParse(await safeJsonBody(c).catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }

    const { sessionId, mode, subMode, userInput, contentParts, model, ttsEnabled } = parsed.data;

    const effectiveSessionId = sessionId
      ?? bindings.session.createSession().id;

    const { turnId, events } = await orchestrator.run({
      sessionId: effectiveSessionId,
      mode: mode,
      subMode: subMode,
      userInput: userInput ?? '',
      contentParts: contentParts,
      model: model,
      ttsEnabled: ttsEnabled ?? false,
    });

    // ── Fan-out: push every event into TurnEventStore for replay ──────────
    (async () => {
      for await (const event of events) {
        const cursor = eventStore.push(turnId, event);
        if (cursor !== null) {
          eventHub.publish(turnId, { cursor, event });
        }
        // Auto-cancel any in-flight permission prompts when the turn ends.
        // Otherwise an aborted turn leaves the prompt hanging in the
        // registry — and on the frontend — until the 120 s timeout fires.
        if (isTerminalTurnEvent(event)) {
          const n = bindings.permissionPrompts.cancelForTurn(turnId, `turn ${event.type}`);
          if (n > 0) console.log(`[permission] cancelled ${n} prompt(s) on ${event.type}`);
        }
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

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | null = null;
    const cleanup = (): void => {
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
    };

    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          let closed = false;
          let cursor = lastEventId;

          const close = (): void => {
            if (closed) return;
            closed = true;
            cleanup();
            try { controller.close(); } catch { /* ignore */ }
          };

          const writeEncoded = (payload: string): void => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(payload));
            } catch {
              close();
            }
          };

          const writeEvent = (event: EmaStreamEvent): void => {
            writeEncoded(encodeEvent(event));
            if (isTerminalTurnEvent(event)) close();
          };

          unsubscribe = eventHub.subscribe(turnId, (published) => {
            if (published.cursor <= cursor) return;
            cursor = published.cursor;
            writeEvent(published.event);
          });

          // ── Send missed events immediately ──────────────────────────────
          const missed = eventStore.replay(turnId, cursor);
          for (const event of missed) {
            if (closed) break;
            cursor += 1;
            writeEvent(event);
          }

          if (closed || eventStore.isDone(turnId)) {
            close();
            return;
          }

          // ── Heartbeat ───────────────────────────────────────────────────
          heartbeat = setInterval(() => {
            writeEncoded(encodePing());
          }, 15_000);
        },
        cancel() {
          // Client disconnected — mark turn as cancelled so further push() calls
          // are dropped. Do NOT call clear() here: that would erase the cancelled
          // entry and let the background fan-out IIFE silently re-create the store
          // entry with no reader on the other end.
          cleanup();
          if (!eventStore.isDone(turnId) && eventHub.subscriberCount(turnId) === 0) {
            eventStore.cancel(turnId);
          }
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

  // ── GET /api/turns/:turnId/audio ───────────────────────────────────────────
  //
  // Returns the merged audio for a turn. Files written by TtsCoordinator after
  // its finalize step; the route just streams from disk. 404 if no audio:
  //   - turn ran without ttsEnabled=true
  //   - turn aborted before any TTS sentence completed
  //   - turn predates the audio archive feature
  app.get('/:turnId/audio', async (c) => {
    const turnId = c.req.param('turnId');
    const found  = bindings.audioArchive.findMergedFor(turnId);
    if (!found) return c.json({ error: 'audio_not_found' }, 404);

    const stat = await fs.promises.stat(found.path);
    const stream = fs.createReadStream(found.path);
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        'Content-Type':   found.mime,
        'Content-Length': String(stat.size),
        'Cache-Control':  'private, max-age=0',
      },
    });
  });

  // ── POST /api/turns/:turnId/ask-user/:promptId/respond ─────────────────────
  //
  // Resolves a pending ask_user prompt. The tool awaits a Promise stored in
  // AskUserRegistry; this POST resolves it with the user's answers map.
  app.post('/:turnId/ask-user/:promptId/respond', async (c) => {
    const promptId = c.req.param('promptId');
    const body = await c.req.json().catch(() => null) as { answers?: Record<string, string> } | null;
    if (!body || typeof body.answers !== 'object') {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const ok = bindings.askUserRegistry.respond(promptId, body.answers);
    if (!ok) return c.json({ error: 'not_found_or_expired', promptId }, 404);
    return c.json({ ok: true });
  });

  return app;
}

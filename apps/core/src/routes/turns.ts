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
import { asTurnId, asSessionId } from '@ema-agent/contracts';

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

const attachmentInputSchema = z.object({
  id:        z.string(),
  name:      z.string(),
  mimeType:  z.string(),
  size:      z.number().int().nonnegative(),
  mtime:     z.number().int().nonnegative(),
  localPath: z.string(),
});

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
  userInput: z.string().optional(),
  contentParts: z.array(contentPartSchema).optional(),
  attachments:  z.array(attachmentInputSchema).optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  ttsEnabled:    z.boolean().optional(),
  /** KB ids the user selected in the chat picker (turn-level search scope). */
  kbIds:         z.array(z.string()).optional(),
  /** Per-KB document scopes: which docs within each KB are selected. */
  kbAssetScopes: z.array(z.object({ kbId: z.string(), assetIds: z.array(z.string()) })).optional(),
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

function enrichTurnEvent(
  event: EmaStreamEvent,
  sessionId: string,
): EmaStreamEvent {
  if ('sessionId' in event && (event as Record<string, unknown>).sessionId !== undefined) return event;
  return { ...event, sessionId } as EmaStreamEvent;
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

    const { sessionId, mode, userInput, contentParts, attachments, providerId, model, ttsEnabled, kbIds, kbAssetScopes } = parsed.data;

    // Trust the client's sessionId only if it still exists. A stale id (e.g.
    // a viewedSessionId persisted across a DB reset) would otherwise FK-fail
    // the turn insert with an opaque 500 and block every send. Fall back to a
    // fresh session — the frontend already reconciles when the returned
    // sessionId differs from what it sent.
    const effectiveSessionId =
      sessionId && bindings.session.sessionExists(asSessionId(sessionId))
        ? asSessionId(sessionId)
        : bindings.session.createSession().id;

    let turnId: TurnId;
    let events: AsyncIterable<EmaStreamEvent>;
    try {
      ({ turnId, events } = await orchestrator.run({
        sessionId:        effectiveSessionId,
        mode,
        userInput:        userInput ?? '',
        contentParts,
        attachmentInputs: attachments,
        providerId,
        model,
        kbIds,
        kbAssetScopes,
        ttsEnabled:       ttsEnabled ?? false,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Expected concurrency conflict — tell the client to retry, not "server broke".
      if (message.startsWith('session_busy')) {
        return c.json({ error: 'session_busy', message }, 409);
      }
      console.error('[turns] orchestrator.run failed', err);
      return c.json({ error: 'internal', message }, 500);
    }

    // ── Fan-out: push every event into TurnEventStore for replay ──────────
    //
    // Also intercepts subagent_stream events to persist the subagent's
    // conversation transcript into agent_task_messages via the messages repo.
    // Text deltas are accumulated per-subagent and flushed on iteration
    // boundaries or lifecycle terminal events.
    const subagentTextAcc = new Map<string, string>();

    const flushSubagentText = (subagentId: string): void => {
      const text = subagentTextAcc.get(subagentId);
      if (!text) return;
      subagentTextAcc.delete(subagentId);
      bindings.agentTaskMessages.insert({
        taskId:    subagentId,
        role:      'assistant',
        content:   { text },
        createdAt: Date.now(),
      });
    };

    (async () => {
      for await (const event of events) {
        // Inject sessionId into events from engines that don't carry it.
        const enriched = enrichTurnEvent(event, effectiveSessionId);
        const cursor = eventStore.push(turnId, enriched);
        if (cursor !== null) {
          eventHub.publish(turnId, { cursor, event: enriched });
        }

        // ── Subagent transcript persistence ────────────────────────────────
        if (enriched.type === 'subagent_stream') {
          const { subagentId, ev: inner } = enriched;
          if (inner.type === 'text_delta') {
            subagentTextAcc.set(subagentId, (subagentTextAcc.get(subagentId) ?? '') + inner.delta);
          } else if (inner.type === 'iteration') {
            flushSubagentText(subagentId);
          } else if (inner.type === 'tool_call') {
            flushSubagentText(subagentId);
            bindings.agentTaskMessages.insert({
              taskId:    subagentId,
              role:      'tool_call',
              content:   { callId: inner.callId, name: inner.name, args: inner.args, iteration: inner.iteration },
              createdAt: Date.now(),
            });
          } else if (inner.type === 'tool_result') {
            bindings.agentTaskMessages.insert({
              taskId:    subagentId,
              role:      'tool_result',
              content:   { callId: inner.callId, name: inner.name, excerpt: inner.excerpt, isError: inner.isError, error: inner.error, durationMs: inner.durationMs },
              createdAt: Date.now(),
            });
          }
        } else if (
          enriched.type === 'subagent_completed' ||
          enriched.type === 'subagent_failed'    ||
          enriched.type === 'subagent_aborted'
        ) {
          flushSubagentText(enriched.subagentId);
          subagentTextAcc.delete(enriched.subagentId);
        }

        // Auto-cancel any in-flight permission prompts when the turn ends.
        // Otherwise an aborted turn leaves the prompt hanging in the
        // registry — and on the frontend — until the 120 s timeout fires.
        if (isTerminalTurnEvent(enriched)) {
          const n = bindings.permissionPrompts.cancelForTurn(turnId, `turn ${enriched.type}`);
          if (n > 0) console.log(`[permission] cancelled ${n} prompt(s) on ${enriched.type}`);
          const m = bindings.askUserRegistry.cancelForTurn(turnId as string);
          if (m > 0) console.log(`[ask_user] cancelled ${m} prompt(s) on ${enriched.type}`);
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
          // Client disconnected — abort the running turn so the LLM stream,
          // tool calls, and TTS synthesis all stop. Also mark the event store
          // as cancelled so further push() calls are dropped.
          cleanup();
          if (!eventStore.isDone(turnId) && eventHub.subscriberCount(turnId) === 0) {
            eventStore.cancel(turnId);
            orchestrator.abort(turnId);
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

  // ── DELETE /api/turns/:turnId/subagents/:subagentId ───────────────────────
  //
  // Cancel a single sub-agent without aborting the parent turn.
  // No-op (returns 200) if the subagentId is not currently active.
  app.delete('/:turnId/subagents/:subagentId', (c) => {
    const turnId     = asTurnId(c.req.param('turnId'));
    const subagentId = c.req.param('subagentId');
    orchestrator.abortSubagent(turnId, subagentId);
    return c.json({ ok: true });
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

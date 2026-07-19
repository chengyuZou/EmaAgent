// 接收 Turn 请求、发布有界 SSE 事件流并处理显式取消等运行时控制。

import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { TurnEventHub } from '../sse/event-hub.js';
import { TurnEventStore } from '../sse/event-store.js';
import { encodeEvent, encodePing } from '../sse/writer.js';
import type { AppBindings } from '../wiring/index.js';
import type { EmaStreamEvent, TurnId, TurnRequest } from '@ema-agent/contracts';
import { asTurnId, asSessionId, hasTurnRequestInput } from '@ema-agent/contracts';
import { REQUEST_VALUE_LIMITS } from '../http/request-budget.js';
import { SubagentTranscriptProjection } from '../turn-runtime/subagent-transcript-projection.js';

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
  userInput: z.string().max(REQUEST_VALUE_LIMITS.maxTurnTextChars).optional(),
  contentParts: z.array(contentPartSchema).max(REQUEST_VALUE_LIMITS.maxTurnContentParts).optional(),
  attachments:  z.array(attachmentInputSchema).max(REQUEST_VALUE_LIMITS.maxTurnAttachments).optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  ttsEnabled:       z.boolean().optional(),
  thinkingEnabled:  z.boolean().optional(),
  /** KB ids the user selected in the chat picker (turn-level search scope). */
  kbIds:         z.array(z.string()).max(REQUEST_VALUE_LIMITS.maxTurnKbIds).optional(),
  /** Per-KB document scopes: which docs within each KB are selected. */
  kbAssetScopes: z.array(z.object({ kbId: z.string(), assetIds: z.array(z.string()) }))
    .max(REQUEST_VALUE_LIMITS.maxTurnKbAssetScopes)
    .optional(),
}).refine(
  hasTurnRequestInput,
  { message: 'either userInput, contentParts, or attachments is required' },
);

// ── Drift guard ───────────────────────────────────────────────────────────────
// Forces a compile error when T is not `true` — used to assert that the Zod
// schema above stays in sync with the canonical TurnRequest wire type in
// @ema-agent/contracts. If editing either side, the error here tells you the
// other side is out of date.
type RequireTrue<T extends true> = T;
type TurnBodySchemaMatchesContract = RequireTrue<
  z.infer<typeof turnBodySchema> extends TurnRequest ? true : false
>;

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
    onAudioFinalized: (turnId, sessionId, audio) => {
      if (audio) {
        try {
          // 音频统计是可重建的辅助投影，失败不能反向破坏已生成的语音与 Turn。
          bindings.sessionStats.recordAudioMerged({
            turnId:       turnId as string,
            sessionId:    sessionId as string,
            storagePath:  audio.path,
            mimeType:     audio.mime,
            byteSize:     audio.byteSize,
            durationMs:   audio.durationMs,
            segmentCount: audio.segmentCount,
            createdAt:    Date.now(),
          });
        } catch (error) {
          const warning: EmaStreamEvent = {
            type: 'turn_projection_warning',
            sessionId,
            turnId,
            projection: 'turn_audio',
            code: 'storage/turn_audio_projection_failed',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          };
          const result = eventStore.push(turnId, warning);
          if (result.status === 'stored') {
            eventHub.publish(turnId, { cursor: result.published.cursor, event: warning });
          }
        }
        eventStore.evictAudioChunks(turnId);
      }
    },
  });
  // Evict completed / cancelled turns every 30 s to prevent unbounded memory growth.
  setInterval(() => eventStore.evictExpired(), 30_000).unref?.();

  // 窗口重开时恢复仍在等待回答的 Ask User 卡片；请求本身已包含 Session/Turn 身份。
  app.get('/pending/ask-user', (c) => {
    const prompts = bindings.askUserRegistry.listPending();
    return c.json({ count: prompts.length, prompts });
  });

  // ── POST /api/turns ────────────────────────────────────────────────────────
  app.post('/', async (c) => {
    const parsed = turnBodySchema.safeParse(await safeJsonBody(c).catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }

    const { sessionId, mode, userInput, contentParts, attachments, providerId, model, ttsEnabled, thinkingEnabled, kbIds, kbAssetScopes } = parsed.data;

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
        thinking:         thinkingEnabled ? { enabled: true as const, budgetTokens: 8000 } : undefined,
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

    // Transcript 是旁路投影；它可以失败，但不能停止 Engine 事件消费。
    const transcriptProjection = new SubagentTranscriptProjection(bindings.agentTaskMessages);

    const publishEvent = (event: EmaStreamEvent): boolean => {
      const result = eventStore.push(turnId, event);
      if (result.status === 'stored') {
        // 重放日志可能对音频做脱敏，在线订阅者仍应收到原始事件。
        eventHub.publish(turnId, { cursor: result.published.cursor, event });
        return true;
      }
      if (result.status === 'overflow') {
        orchestrator.abort(turnId);
      }
      return false;
    };

    (async () => {
      for await (const event of events) {
        // Inject sessionId into events from engines that don't carry it.
        const enriched = enrichTurnEvent(event, effectiveSessionId);
        const projectionWarning = transcriptProjection.apply(enriched);
        if (projectionWarning) {
          publishEvent({
            type: 'turn_projection_warning',
            sessionId: effectiveSessionId,
            turnId,
            ...projectionWarning,
          });
        }
        publishEvent(enriched);

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

  // ── GET /api/turns/:turnId/tool-executions ────────────────────────────────
  //
  // Session 消息可能因 Provider 流中断而来不及投影；该接口读取持久化执行日志，
  // 供审计页解释“Turn 失败但文件为何发生变化”。
  app.get('/:turnId/tool-executions', (c) => {
    const turnId = asTurnId(c.req.param('turnId'));
    if (!bindings.session.getTurn(turnId)) {
      return c.json({ error: 'turn_not_found' }, 404);
    }
    return c.json({ executions: bindings.toolExecutionJournal.listForTurn(turnId) });
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

          const writeEvent = (published: { cursor: number; event: EmaStreamEvent }): void => {
            writeEncoded(encodeEvent(published.event, published.cursor));
            if (isTerminalTurnEvent(published.event)) close();
          };

          unsubscribe = eventHub.subscribe(turnId, (published) => {
            if (published.cursor <= cursor) return;
            cursor = published.cursor;
            writeEvent(published);
          });

          // ── Send missed events immediately ──────────────────────────────
          const missed = eventStore.replay(turnId, cursor);
          for (const published of missed) {
            if (closed) break;
            cursor = published.cursor;
            writeEvent(published);
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
          // 断开只结束当前订阅。Turn 生命周期由显式 /abort、预算或 Engine 终态
          // 控制，窗口刷新和短暂断网不能偷偷取消仍在运行的工具或模型请求。
          cleanup();
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
    // findMergedFor is per-session — resolve the turn's sessionId first.
    const turn = bindings.session.getTurn(turnId as TurnId);
    if (!turn) return c.json({ error: 'turn_not_found' }, 404);
    const found  = bindings.audioArchive.findMergedFor(turn.sessionId as string, turnId);
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

  // ── DELETE /api/turns/:turnId/tools/:callId ────────────────────────────────
  //
  // Cancel a single in-flight tool without aborting the parent turn.
  // The tool receives a per-tool AbortSignal; partial output (if any) is
  // returned as the tool_result so the LLM can decide how to proceed.
  // Returns 404 if the callId is not currently active.
  app.delete('/:turnId/tools/:callId', (c) => {
    const turnId = asTurnId(c.req.param('turnId'));
    const callId = c.req.param('callId');
    const aborted = orchestrator.abortTool(turnId, callId);
    if (!aborted) return c.json({ ok: false, reason: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  // ── POST /api/turns/:turnId/abort ──────────────────────────────────────────
  //
  // Cancel the whole turn — LLM stream + all in-flight tools. The frontend
  // calls this when the user clicks Stop: disconnecting SSE alone doesn't
  // reach the backend, so without this the turn keeps running (LLM keeps
  // burning tokens, tools keep executing) after the UI shows "stopped".
  // No-op (200) if the turn isn't currently active.
  app.post('/:turnId/abort', (c) => {
    const turnId = asTurnId(c.req.param('turnId'));
    orchestrator.abort(turnId);
    return c.json({ ok: true });
  });

  // ── POST /api/turns/:turnId/ask-user/:promptId/respond ─────────────────────
  //
  // Resolves a pending ask_user prompt. The tool awaits a Promise stored in
  // AskUserRegistry; this POST resolves it with the user's answers map.
  app.post('/:turnId/ask-user/:promptId/respond', async (c) => {
    const turnId = c.req.param('turnId');
    const promptId = c.req.param('promptId');
    const body = await c.req.json().catch(() => null) as { answers?: Record<string, string> } | null;
    if (!body || typeof body.answers !== 'object') {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const ok = bindings.askUserRegistry.respond(promptId, body.answers, turnId);
    if (!ok) return c.json({ error: 'not_found_or_expired', promptId }, 404);
    return c.json({ ok: true });
  });

  // 取消不是“提交空答案”：单独的路由让前端意图和后端状态机保持一致。
  app.post('/:turnId/ask-user/:promptId/cancel', (c) => {
    const turnId = c.req.param('turnId');
    const promptId = c.req.param('promptId');
    const ok = bindings.askUserRegistry.cancel(promptId, turnId);
    if (!ok) return c.json({ error: 'not_found_or_expired', promptId }, 404);
    return c.json({ ok: true });
  });

  return app;
}

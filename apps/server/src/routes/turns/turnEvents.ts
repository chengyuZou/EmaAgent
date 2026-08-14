// 提供 Turn SSE 实时订阅、短时重放、心跳和终态关闭行为。

import type { Hono } from 'hono';
import type { TurnStreamEvent } from '@ema-agent/events';
import { asTurnId } from '@ema-agent/ids';
import {
  encodeEvent,
  encodePing,
} from '../../sse/writer.js';
import type {
  PublishedTurnEvent,
  TurnEventHub,
} from '../../sse/event-hub.js';
import type { TurnEventStore } from '../../sse/event-store.js';

export function registerTurnEventRoutes(
  app: Hono,
  eventStore: TurnEventStore,
  eventHub: TurnEventHub,
): void {
  app.get('/:turnId/events', (context) => {
    const turnId = asTurnId(context.req.param('turnId'));
    if (!eventStore.has(turnId)) {
      return context.json({ error: 'turn_event_stream_not_found' }, 404);
    }

    const lastEventId = parseLastEventId(context.req.query('lastEventId'));
    if (lastEventId === null) {
      return context.json({ error: 'invalid_last_event_id' }, 400);
    }

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
            try {
              controller.close();
            } catch {
              // 客户端可能已经主动断开。
            }
          };

          const writeEncoded = (payload: string): void => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(payload));
            } catch {
              close();
            }
          };

          const writeEvent = (published: PublishedTurnEvent): void => {
            writeEncoded(encodeEvent(published.event, published.cursor));
            if (isTerminalTurnEvent(published.event)) close();
          };

          unsubscribe = eventHub.subscribe(turnId, (published) => {
            if (published.cursor <= cursor) return;
            cursor = published.cursor;
            writeEvent(published);
          });

          // 先订阅再重放，避免在两步之间漏掉刚产生的事件。
          for (const published of eventStore.replay(turnId, cursor)) {
            if (closed) break;
            cursor = published.cursor;
            writeEvent(published);
          }

          if (closed || eventStore.isDone(turnId)) {
            close();
            return;
          }

          heartbeat = setInterval(() => {
            writeEncoded(encodePing());
          }, 15_000);
        },
        cancel() {
          // SSE 断开只结束订阅；Turn 只能由显式取消、预算或自身终态结束。
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
}

function parseLastEventId(value: string | undefined): number | null {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isTerminalTurnEvent(event: TurnStreamEvent): boolean {
  return (
    event.type === 'turn_aborted' ||
    event.type === 'turn_failed' ||
    event.type === 'turn_completed'
  );
}

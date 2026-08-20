// Turn 事件流 SSE 端点：先订阅再重放，游标去重，终态事件到达后关闭连接。
import { Hono } from 'hono';
import {
  encodeEvent,
  encodePing,
} from '../../sse/writer.js';
import type {
  EventHub,
  PublishedTurnEvent,
  TurnWireEvent,
} from '../../sse/eventHub.js';
import type { TurnEventStore } from '../../sse/eventStore.js';

export interface TurnEventsRouteDeps {
  readonly hub: EventHub;
  readonly store: TurnEventStore;
}

export function turnEventsRoute(deps: TurnEventsRouteDeps): Hono {
  const app = new Hono();

  app.get('/:turnId/events', context => {
    const turnId = context.req.param('turnId');
    if (!deps.store.has(turnId)) {
      return context.json({ error: 'turn_event_stream_not_found' }, 404);
    }

    const lastEventId = parseLastEventId(context.req.query('lastEventId'));
    if (lastEventId === null) {
      return context.json({ error: 'invalid_last_event_id' }, 400);
    }

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;

    const cleanup = (): void => {
      unsubscribe?.();
      unsubscribe = undefined;
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
            if (isTerminalWireEvent(published.event)) close();
          };

          unsubscribe = deps.hub.subscribeTurn(turnId, published => {
            if (published.cursor <= cursor) return;
            cursor = published.cursor;
            writeEvent(published);
          });

          // 先订阅再重放，避免在两步之间漏掉刚产生的事件。
          for (const published of deps.store.replay(turnId, cursor)) {
            if (closed) break;
            cursor = published.cursor;
            writeEvent(published);
          }

          if (closed || deps.store.isDone(turnId)) {
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

  return app;
}

function parseLastEventId(value: string | undefined): number | null {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isTerminalWireEvent(event: TurnWireEvent): boolean {
  return event.type === 'turn_completed'
    || event.type === 'turn_failed'
    || event.type === 'turn_aborted';
}

// 提供跨 Turn 系统事件的 SSE 订阅与订阅诊断的 HTTP 边界。
import { Hono } from 'hono';
import { encodeEvent, encodePing } from '../sse/writer.js';
import type { SystemEventBus } from '../sse/system-bus.js';

/** 系统事件 SSE 只需要订阅和诊断计数，不接触事件生产侧。 */
type SystemEventSubscription = Pick<
  SystemEventBus,
  'subscribe' | 'subscriberCount'
>;

// ── /api/system/events ───────────────────────────────────────────────────────

/**
 * Global SSE stream for events that don't belong to a single turn:
 *   memory_extraction_*, memory_consolidation_*, memory_maintenance_*, *   memory_index_rebuilt, memory_node_merged,
 *   background_task_*, character_card_switched
 *
 * Frontend opens this in parallel with /api/turns/:id/events. The bubble
 * manager filters/styles each event by type via displaySettings.
 *
 * No reconnect replay buffer — system events are advisory. If you miss them,
 * they're gone. Frontend can fetch /api/memory/stats etc. for snapshots.
 */
export function systemEventsRoute(systemBus: SystemEventSubscription): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | null = null;

    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          let closed = false;

          unsubscribe = systemBus.subscribe((ev) => {
            if (closed) return;
            try { controller.enqueue(encoder.encode(encodeEvent(ev))); }
            catch { /* client gone — cancel() will clean up */ }
          });

          heartbeat = setInterval(() => {
            if (closed) return;
            try { controller.enqueue(encoder.encode(encodePing())); }
            catch { /* ignore */ }
          }, 15_000);
        },
        cancel() {
          unsubscribe?.();
          unsubscribe = null;
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = undefined;
        },
      }),
      {
        headers: {
          'Content-Type':       'text/event-stream',
          'Cache-Control':      'no-cache',
          'Connection':         'keep-alive',
          'X-Accel-Buffering':  'no',
        },
      },
    );
  });

  app.get('/diagnostics', (c) => {
    return c.json({ subscribers: systemBus.subscriberCount() });
  });

  return app;
}

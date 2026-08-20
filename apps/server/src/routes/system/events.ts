// 应用事件 SSE：跨 Turn 的全局事实与询问（KB/角色/后台进程/设置/stdio 批准等）。
// 无重放——应用事件是提示性的，错过即过；快照类状态走各域查询端点。
import { Hono } from 'hono';
import type { EventHub } from '../../sse/eventHub.js';
import { encodeEvent, encodePing } from '../../sse/writer.js';

export interface SystemEventsRouteDeps {
  readonly hub: Pick<EventHub, 'subscribeApp' | 'appSubscriberCount'>;
}

export function systemEventsRoute(deps: SystemEventsRouteDeps): Hono {
  const app = new Hono();

  app.get('/events', context => {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          unsubscribe = deps.hub.subscribeApp(event => {
            try {
              controller.enqueue(encoder.encode(encodeEvent(event)));
            } catch {
              // 客户端已走；cancel() 统一清理。
            }
          });
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(encodePing()));
            } catch {
              // 同上。
            }
          }, 15_000);
        },
        cancel() {
          unsubscribe?.();
          if (heartbeat) clearInterval(heartbeat);
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      },
    );
  });

  app.get('/events/diagnostics', context => {
    return context.json({ subscribers: deps.hub.appSubscriberCount() });
  });

  return app;
}

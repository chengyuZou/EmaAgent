// 应用事件 SSE：只发送跨 Turn 的提示事件，查询型状态由各业务 Route 返回。
import { Hono } from 'hono';
import type { AppEvents } from '../../application/appEvents.js';

export const systemEventsRoute = (events: AppEvents) =>
  new Hono().get('/events', () => {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        unsubscribe = events.subscribe(event => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            // 连接关闭后由 cancel 清理订阅。
          }
        });
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode('event: heartbeat\ndata: {}\n\n'));
          } catch {
            // 连接关闭后由 cancel 清理定时器。
          }
        }, 15_000);
      },
      cancel() {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
      },
    }), {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

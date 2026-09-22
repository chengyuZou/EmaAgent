// 应用事件 SSE：只发送跨 Turn 的提示事件，查询型状态由各业务 Route 返回。
import { Hono } from 'hono';
import type { AppEvents } from '../../application/appEvents.js';

export const systemEventsRoute = (events: AppEvents) =>
  new Hono().get('/events', context => {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    let closeStream: (() => void) | undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const send = (frame: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            close();
          }
        };
        const close = (): void => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          if (heartbeat) clearInterval(heartbeat);
          context.req.raw.signal.removeEventListener('abort', close);
          try {
            controller.close();
          } catch {
            // Response body 已由消费者取消。
          }
        };
        closeStream = close;
        unsubscribe = events.subscribe(event => {
          send(`data: ${JSON.stringify(event)}\n\n`);
        });
        context.req.raw.signal.addEventListener('abort', close, { once: true });
        heartbeat = setInterval(() => {
          send('event: heartbeat\ndata: {}\n\n');
        }, 15_000);
        if (context.req.raw.signal.aborted) {
          close();
          return;
        }
        send('event: heartbeat\ndata: {}\n\n');
      },
      cancel() {
        closeStream?.();
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

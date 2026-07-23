// 测试 SSE 分帧、结构化终态、失活超时与主动取消。
import { describe, it, expect } from 'vitest';
import {
  createSseConsumer,
  type SseConnectionOutcome,
} from '../src/lib/sse-consumer.js';
import type { EmaStreamEvent } from '@ema-agent/events';

function mockSseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = frames.map((frame) => `${frame}\n\n`).join('');
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < body.length; index += 3) {
    chunks.push(encoder.encode(body.slice(index, index + 3)));
  }

  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk) {
        controller.enqueue(chunk);
        index += 1;
      } else {
        controller.close();
      }
    },
  });

  return {
    ok: status >= 200 && status < 300,
    status,
    body: stream,
    headers: new Headers(),
  } as Response;
}

async function collectSse(frames: string[]): Promise<{
  events: EmaStreamEvent[];
  cursors: Array<number | undefined>;
  heartbeats: number;
  outcome: SseConnectionOutcome;
}> {
  const events: EmaStreamEvent[] = [];
  const cursors: Array<number | undefined> = [];
  let heartbeats = 0;
  const handle = createSseConsumer().start({
    openResponse: async () => mockSseResponse(frames),
    onEvent(event, cursor) {
      events.push(event);
      cursors.push(cursor);
    },
    onHeartbeat() {
      heartbeats += 1;
    },
  });

  const outcome = await handle.done;
  return { events, cursors, heartbeats, outcome };
}

describe('createSseConsumer', () => {
  it('解析跨 chunk 的多个事件并返回 EOF', async () => {
    const result = await collectSse([
      'data: {"type":"turn_started","turnId":"t1","executionProfile":"chat","narrativePolicy":"auto"}',
      'data: {"type":"output_text_delta","blockIndex":0,"delta":"Hello"}',
      'data: {"type":"turn_completed","turnId":"t1","usage":{"inputTokens":10,"outputTokens":5,"durationMs":100}}',
    ]);

    expect(result.events.map((event) => event.type)).toEqual([
      'turn_started',
      'output_text_delta',
      'turn_completed',
    ]);
    expect(result.outcome.kind).toBe('eof');
  });

  it('把服务端 SSE id 作为绝对续传游标', async () => {
    const result = await collectSse([
      'id: 42\ndata: {"type":"system_warning","level":"warn","message":"cursor"}',
    ]);

    expect(result.cursors).toEqual([42]);
    expect(result.outcome.lastEventId).toBe(42);
  });

  it('心跳只刷新连接，不进入业务事件', async () => {
    const result = await collectSse([
      'event: heartbeat\ndata: {}',
      'data: {"type":"turn_started","turnId":"t1","executionProfile":"chat","narrativePolicy":"auto"}',
      'event: heartbeat\ndata: {}',
    ]);

    expect(result.heartbeats).toBe(2);
    expect(result.events).toHaveLength(1);
  });

  it('协议帧缺少 type 时立即终止连接', async () => {
    const result = await collectSse([
      'data: {"noType":true}',
      'data: {"type":"turn_started","turnId":"t1","executionProfile":"chat","narrativePolicy":"auto"}',
    ]);

    expect(result.events).toHaveLength(0);
    expect(result.outcome.kind).toBe('protocol_error');
  });

  it('要求回放游标时拒绝没有 SSE id 的业务事件', async () => {
    const handle = createSseConsumer().start({
      requireEventId: true,
      openResponse: async () => mockSseResponse([
        'data: {"type":"turn_started","turnId":"t1","executionProfile":"chat","narrativePolicy":"auto"}',
      ]),
      onEvent() {},
    });

    expect((await handle.done).kind).toBe('protocol_error');
  });

  it('保留 HTTP 错误状态', async () => {
    const handle = createSseConsumer().start({
      openResponse: async () => mockSseResponse([], 500),
      onEvent() {},
    });

    const outcome = await handle.done;
    expect(outcome.kind).toBe('http_error');
    if (outcome.kind === 'http_error') expect(outcome.status).toBe(500);
  });

  it('连接长时间无任何字节时返回 idle_timeout', async () => {
    const handle = createSseConsumer().start({
      idleTimeoutMs: 10,
      openResponse: async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>(),
      }) as Response,
      onEvent() {},
    });

    expect((await handle.done).kind).toBe('idle_timeout');
  });

  it('主动停止只产生一次 cancelled 终态', async () => {
    const handle = createSseConsumer().start({
      openResponse: async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>(),
      }) as Response,
      onEvent() {},
    });

    handle.stop();
    handle.stop();
    expect((await handle.done).kind).toBe('cancelled');
  });

  it('业务事件处理异常会关闭旧连接', async () => {
    const handle = createSseConsumer().start({
      openResponse: async () => mockSseResponse([
        'data: {"type":"turn_started","turnId":"t1","executionProfile":"chat","narrativePolicy":"auto"}',
      ]),
      onEvent() {
        throw new Error('store rejected event');
      },
    });

    const outcome = await handle.done;
    expect(outcome.kind).toBe('consumer_error');
  });
});

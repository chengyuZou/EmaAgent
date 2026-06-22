/**
 * sse-consumer.test.ts — mock fetch, construct SSE chunks, verify onEvent/onError/onComplete.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSseConsumer } from './sse-consumer.js';
import type { EmaStreamEvent } from '@ema-agent/contracts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a mock Response with a ReadableStream body from SSE frames.
 * Uses pull-based ReadableStream for reliable Node.js compat.
 */
function mockSseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = frames.map((f) => f + '\n\n').join('');
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < body.length; i += 3) {
    chunks.push(encoder.encode(body.slice(i, i + 3)));
  }

  let idx = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(chunks[idx]!);
        idx++;
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
  } as unknown as Response;
}

/**
 * Start an SSE consumer, collect results, resolve on complete or timeout.
 */
function collectSse(frames: string[], timeoutMs = 3000): Promise<{
  events: EmaStreamEvent[];
  heartbeats: number;
  errors: Error[];
  completed: boolean;
}> {
  return new Promise((resolve) => {
    const events: EmaStreamEvent[] = [];
    let heartbeats = 0;
    const errors: Error[] = [];
    let completed = false;

    const timer = setTimeout(() => {
      handle.stop();
      resolve({ events, heartbeats, errors, completed });
    }, timeoutMs);

    const consumer = createSseConsumer();
    const handle = consumer.start({
      url: 'http://127.0.0.1:3421/sse',
      onEvent: (e) => events.push(e),
      onHeartbeat: () => { heartbeats++; },
      onError: (e) => errors.push(e),
      onComplete: () => {
        completed = true;
        clearTimeout(timer);
        handle.stop();
        resolve({ events, heartbeats, errors, completed });
      },
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createSseConsumer', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses a simple turn_started event', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockSseResponse(['data: {"type":"turn_started","turnId":"t1","mode":"chat"}']),
    );

    const result = await collectSse(['data: {"type":"turn_started","turnId":"t1","mode":"chat"}']);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: 'turn_started', turnId: 't1', mode: 'chat' });
    expect(result.errors).toHaveLength(0);
  });

  it('parses multiple events in a single stream', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockSseResponse([
        'data: {"type":"turn_started","turnId":"t1","mode":"chat"}',
        'data: {"type":"output_text_delta","blockIndex":0,"delta":"Hello"}',
        'data: {"type":"turn_completed","turnId":"t1","usage":{"inputTokens":10,"outputTokens":5,"durationMs":100}}',
      ]),
    );

    const result = await collectSse([
      'data: {"type":"turn_started","turnId":"t1","mode":"chat"}',
      'data: {"type":"output_text_delta","blockIndex":0,"delta":"Hello"}',
      'data: {"type":"turn_completed","turnId":"t1","usage":{"inputTokens":10,"outputTokens":5,"durationMs":100}}',
    ]);

    expect(result.events).toHaveLength(3);
    expect(result.events[0]!.type).toBe('turn_started');
    expect(result.events[1]!.type).toBe('output_text_delta');
    expect(result.events[2]!.type).toBe('turn_completed');
  });

  it('fires onHeartbeat for heartbeat events', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockSseResponse([
        'event: heartbeat\ndata: {}',
        'event: heartbeat\ndata: {}',
        'data: {"type":"turn_started","turnId":"t1","mode":"chat"}',
        'event: heartbeat\ndata: {}',
      ]),
    );

    const result = await collectSse([
      'event: heartbeat\ndata: {}',
      'event: heartbeat\ndata: {}',
      'data: {"type":"turn_started","turnId":"t1","mode":"chat"}',
      'event: heartbeat\ndata: {}',
    ]);

    expect(result.heartbeats).toBeGreaterThanOrEqual(3);
    expect(result.events).toHaveLength(1);
  });

  it('skips frames with missing "type" field', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockSseResponse([
        'data: {"noType": true}',
        'data: {"type":"turn_started","turnId":"t1","mode":"chat"}',
        'data: {}',
      ]),
    );

    const result = await collectSse([
      'data: {"noType": true}',
      'data: {"type":"turn_started","turnId":"t1","mode":"chat"}',
      'data: {}',
    ]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('turn_started');
  });

  it('fires onError for HTTP 500', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockSseResponse([], 500),
    );

    return new Promise<void>((resolve) => {
      const consumer = createSseConsumer();
      consumer.start({
        url: 'http://127.0.0.1:3421/sse',
        onEvent: () => {},
        onError: (err) => {
          expect(err.message).toContain('500');
          resolve();
        },
        onComplete: () => resolve(),
      });
    });
  });

  it('fires onComplete on stream end', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockSseResponse(['data: {"type":"turn_started","turnId":"t1","mode":"chat"}']),
    );

    const result = await collectSse([
      'data: {"type":"turn_started","turnId":"t1","mode":"chat"}',
    ]);

    expect(result.completed).toBe(true);
  });

  it('handles tool_call events correctly', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockSseResponse([
        'data: {"type":"tool_call_complete","blockIndex":0,"callId":"call_1","name":"read_file","args":{"path":"/tmp/x"}}',
        'data: {"type":"tool_result","callId":"call_1","output":"file content"}',
      ]),
    );

    const result = await collectSse([
      'data: {"type":"tool_call_complete","blockIndex":0,"callId":"call_1","name":"read_file","args":{"path":"/tmp/x"}}',
      'data: {"type":"tool_result","callId":"call_1","output":"file content"}',
    ]);

    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.type).toBe('tool_call_complete');
    expect(result.events[1]!.type).toBe('tool_result');
  });
});

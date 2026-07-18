// 测试 Turn SSE 的断线续传、业务终态和待重连取消。
import { describe, expect, it, vi } from 'vitest';
import type { EmaStreamEvent } from '@ema-agent/contracts';
import type {
  SseConnectionOutcome,
  SseHandle,
  SseStartOptions,
} from '../src/lib/sse-consumer.js';
import { startTurnSseLifecycle } from '../src/lib/turn-sse-lifecycle.js';

function completedHandle(outcome: SseConnectionOutcome): SseHandle {
  return {
    done: Promise.resolve(outcome),
    stop() {},
  };
}

describe('startTurnSseLifecycle', () => {
  it('EOF 没有业务终态时续传，并沿用最后游标', async () => {
    const cursors: number[] = [];
    let connection = 0;
    const lifecycle = startTurnSseLifecycle({
      openResponse: async () => new Response(),
      reconnectDelayMs: () => 0,
      connect(options) {
        cursors.push(options.lastEventId ?? 0);
        connection += 1;
        if (connection === 1) {
          queueMicrotask(() => options.onEvent(
            { type: 'turn_started', turnId: 't1', mode: 'chat' } as EmaStreamEvent,
            7,
          ));
          return completedHandle({ kind: 'eof', lastEventId: 7 });
        }
        queueMicrotask(() => options.onEvent(
          { type: 'turn_completed', turnId: 't1' } as EmaStreamEvent,
          8,
        ));
        return completedHandle({ kind: 'eof', lastEventId: 8 });
      },
      onEvent() {},
      onPermanentDisconnect() {
        throw new Error('不应失败');
      },
    });

    await lifecycle.done;
    expect(cursors).toEqual([0, 7]);
  });

  it('收到 Turn 终态后不再重连', async () => {
    let connects = 0;
    const lifecycle = startTurnSseLifecycle({
      openResponse: async () => new Response(),
      connect(options) {
        connects += 1;
        queueMicrotask(() => options.onEvent(
          { type: 'turn_failed', turnId: 't1', error: 'failed' } as unknown as EmaStreamEvent,
          1,
        ));
        return completedHandle({ kind: 'eof', lastEventId: 1 });
      },
      onEvent() {},
      onPermanentDisconnect() {},
    });

    await lifecycle.done;
    expect(connects).toBe(1);
  });

  it('停止生命周期会取消等待中的重连', async () => {
    vi.useFakeTimers();
    let connects = 0;
    const lifecycle = startTurnSseLifecycle({
      openResponse: async () => new Response(),
      reconnectDelayMs: () => 1000,
      connect(_options: SseStartOptions) {
        connects += 1;
        return completedHandle({ kind: 'eof', lastEventId: 0 });
      },
      onEvent() {},
      onPermanentDisconnect() {},
    });

    await Promise.resolve();
    lifecycle.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await lifecycle.done;
    expect(connects).toBe(1);
    vi.useRealTimers();
  });

  it('超过重连次数后报告永久断开并结束队列占用', async () => {
    const errors: Error[] = [];
    const lifecycle = startTurnSseLifecycle({
      openResponse: async () => new Response(),
      maxReconnects: 0,
      connect() {
        return completedHandle({
          kind: 'network_error',
          lastEventId: 0,
          error: new Error('connection reset'),
        });
      },
      onEvent() {},
      onPermanentDisconnect(error) {
        errors.push(error);
      },
    });

    await lifecycle.done;
    expect(errors[0]?.message).toBe('connection reset');
  });
});

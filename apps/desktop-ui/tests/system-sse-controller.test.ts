// 测试系统 SSE 停止、重连和旧连接隔离，不允许卸载后的连接自行复活。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@ema-agent/events';
import {
  createSystemSseController,
  mountSystemEvents,
  type SystemSseControllerOptions,
} from '../src/lib/system-sse.js';
import type {
  SseConnectionOutcome,
  SseHandle,
} from '../src/lib/sse-consumer.js';
import { tauriBridge } from '../src/lib/tauri-bridge.js';

interface FakeConnection {
  handle: SseHandle;
  emit(event: AppEvent): void;
  finish(outcome: SseConnectionOutcome): void;
  stop: ReturnType<typeof vi.fn>;
}

function createFakeConnection(
  onEvent: (event: AppEvent) => void,
): FakeConnection {
  let finish!: (outcome: SseConnectionOutcome) => void;
  const done = new Promise<SseConnectionOutcome>((resolve) => {
    finish = resolve;
  });
  const stop = vi.fn();
  return {
    handle: { done, stop },
    emit: onEvent,
    finish,
    stop,
  };
}

function createHarness(): {
  connections: FakeConnection[];
  published: AppEvent[];
  disconnected: SseConnectionOutcome[];
  options: SystemSseControllerOptions;
} {
  const connections: FakeConnection[] = [];
  const published: AppEvent[] = [];
  const disconnected: SseConnectionOutcome[] = [];
  return {
    connections,
    published,
    disconnected,
    options: {
      connect(onEvent) {
        const connection = createFakeConnection(onEvent);
        connections.push(connection);
        return connection.handle;
      },
      publish(event) {
        published.push(event);
      },
      onDisconnected(outcome) {
        disconnected.push(outcome);
      },
    },
  };
}

const warningEvent = {
  type: 'system_warning',
  level: 'warn',
  message: 'test',
} as AppEvent;

afterEach(() => {
  vi.useRealTimers();
});

describe('system SSE controller', () => {
  it('显式停止后忽略旧完成回调且不再重连', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const controller = createSystemSseController(harness.options);

    controller.start();
    controller.stop();
    harness.connections[0]!.finish({ kind: 'eof', lastEventId: 0 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.connections[0]!.stop).toHaveBeenCalledOnce();
    expect(harness.connections).toHaveLength(1);
    expect(harness.disconnected).toHaveLength(0);
  });

  it('连接意外 EOF 时按计划建立下一代连接', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const controller = createSystemSseController(harness.options);

    controller.start();
    harness.connections[0]!.finish({ kind: 'eof', lastEventId: 0 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.disconnected).toHaveLength(1);
    expect(harness.connections).toHaveLength(2);
  });

  it('stop 后重新 start 时拒绝旧连接迟到事件', () => {
    const harness = createHarness();
    const controller = createSystemSseController(harness.options);

    controller.start();
    const oldConnection = harness.connections[0]!;
    controller.stop();
    controller.start();
    const currentConnection = harness.connections[1]!;

    oldConnection.emit(warningEvent);
    currentConnection.emit(warningEvent);

    expect(harness.published).toEqual([warningEvent]);
  });

  it('同一窗口的多个订阅租约只安装一个 Tauri listener', async () => {
    const originalIsTauri = tauriBridge.isTauri;
    const originalListen = tauriBridge.listen;
    const unlisten = vi.fn();
    const listen = vi.fn(async () => unlisten);
    tauriBridge.isTauri = () => true;
    tauriBridge.listen = listen;

    try {
      const releaseFirst = mountSystemEvents({ ownsConnection: false });
      const releaseSecond = mountSystemEvents({ ownsConnection: false });
      expect(listen).toHaveBeenCalledOnce();

      releaseFirst();
      await Promise.resolve();
      expect(unlisten).not.toHaveBeenCalled();

      releaseSecond();
      await Promise.resolve();
      expect(unlisten).toHaveBeenCalledOnce();
    } finally {
      tauriBridge.isTauri = originalIsTauri;
      tauriBridge.listen = originalListen;
    }
  });
});

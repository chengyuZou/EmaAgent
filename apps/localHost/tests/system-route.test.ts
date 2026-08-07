// 验证系统只读接口与系统事件 SSE 的订阅、编码和诊断契约。

import { describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@ema-agent/events';
import type { SandboxStatusWire } from '../src/wiring/createSandboxRuntime.js';
import { systemRoute } from '../src/routes/system.js';
import { systemEventsRoute } from '../src/routes/system-events.js';

type RouteSystemBus = Parameters<typeof systemEventsRoute>[0];

const sandboxStatus: SandboxStatusWire = {
  kind: 'unisolated',
  isolation: 'application-only',
  shellExecution: 'unsafe-override',
  sandboxNetwork: 'none',
  localMcpStdio: 'disabled',
};

function createSystemBus(): RouteSystemBus & {
  emitForTest(ev: AppEvent): void;
} {
  const subscribers = new Set<(ev: AppEvent) => void>();
  return {
    subscribe: vi.fn((handler: (ev: AppEvent) => void) => {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    }),
    subscriberCount: vi.fn(() => subscribers.size),
    emitForTest(ev) {
      for (const handler of subscribers) handler(ev);
    },
  };
}

describe('System 只读路由', () => {
  it('GET /disks 返回当前数据目录', async () => {
    const app = systemRoute('D:\\ema-data', sandboxStatus);

    const response = await app.request('/disks');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({ dataDir: 'D:\\ema-data' }),
    );
  });

  it('GET /sandbox 原样返回沙箱状态快照', async () => {
    const app = systemRoute('D:\\ema-data', sandboxStatus);

    const response = await app.request('/sandbox');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(sandboxStatus);
  });
});

describe('System Events SSE 路由', () => {
  it('GET / 把系统总线事件编码为 SSE 帧，断开后退订', async () => {
    const bus = createSystemBus();
    const app = systemEventsRoute(bus);

    const response = await app.request('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const event: AppEvent = {
      type: 'system_warning',
      level: 'warn',
      message: '测试警告',
    };
    bus.emitForTest(event);

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    expect(frame).toBe(`data: ${JSON.stringify(event)}\n\n`);

    await reader.cancel();
    expect(bus.subscriberCount()).toBe(0);
  });

  it('GET /diagnostics 返回当前订阅者计数', async () => {
    const bus = createSystemBus();
    const app = systemEventsRoute(bus);

    const response = await app.request('/diagnostics');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subscribers: 0 });
  });
});

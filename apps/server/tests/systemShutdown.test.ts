import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeLogging, logging } from '@ema-agent/logging';
import { stopServer } from '../src/platform/shutdown.js';

vi.mock('@ema-agent/logging', () => ({
  closeLogging: vi.fn(async () => true),
  logging: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(closeLogging).mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

it.each([false, true])('业务收尾完成或报错后再关闭日志, failure=%s', async fails => {
  const order: string[] = [];
  vi.mocked(closeLogging).mockImplementation(async () => {
    order.push('logs closed');
    return true;
  });
  const code = await stopServer({
    shutdown: async () => {
      order.push('business closed');
      if (fails) throw new Error('close failed');
    },
  }, 'test');
  expect(order).toEqual(['business closed', 'logs closed']);
  expect(code).toBe(fails ? 1 : 0);
  expect(logging).toHaveBeenCalledWith(expect.objectContaining({
    event: fails ? 'server.shutdown.failed' : 'server.stopped',
  }));
});

it('业务收尾卡住时有限等待, 随后仍关闭日志', async () => {
  vi.useFakeTimers();
  const pending = stopServer({ shutdown: () => new Promise<void>(() => {}) }, 'test');
  await vi.advanceTimersByTimeAsync(8_000);
  expect(await pending).toBe(1);
  expect(closeLogging).toHaveBeenCalledOnce();
});

it('日志文件未成功关闭时返回失败退出码', async () => {
  vi.mocked(closeLogging).mockResolvedValue(false);
  expect(await stopServer({ shutdown: async () => {} }, 'test')).toBe(1);
});

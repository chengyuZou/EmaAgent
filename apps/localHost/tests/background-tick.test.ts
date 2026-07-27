// 测试 B-025 single-flight 周期 tick: 慢轮不重入(不叠罗汉), stop 等待在途轮落地。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackgroundTicker } from '../src/wiring/background-tick.js';

describe('createBackgroundTicker (B-025)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('上轮未完成时跳轮, 不并发叠罗汉', async () => {
    let running = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const ticker = createBackgroundTicker({
      intervalMs: 1000,
      onTick: async () => {
        calls++;
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise(resolve => setTimeout(resolve, 3000));  // 慢任务: 跨 3 轮
        running--;
      },
    });

    await vi.advanceTimersByTimeAsync(1000);  // 第 1 轮开始
    await vi.advanceTimersByTimeAsync(2000);  // 第 2/3 轮应被跳过
    expect(calls).toBe(1);
    expect(maxConcurrent).toBe(1);

    await vi.advanceTimersByTimeAsync(2500);  // 慢任务结束 + 下一轮可入
    expect(calls).toBe(2);
    expect(maxConcurrent).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);  // 让第二轮也跑完, stop 才不会干等
    await ticker.stop();
  });

  it('stop 等待在途轮落地后再返回', async () => {
    let finished = false;
    const ticker = createBackgroundTicker({
      intervalMs: 1000,
      onTick: async () => {
        await new Promise(resolve => setTimeout(resolve, 2000));
        finished = true;
      },
    });

    await vi.advanceTimersByTimeAsync(1000);  // 在途一轮开始
    const stopPromise = ticker.stop();
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await stopPromise;
    expect(finished).toBe(true);
  });

  it('tick 抛错被记录但不杀死后续轮次', async () => {
    let calls = 0;
    const ticker = createBackgroundTicker({
      intervalMs: 1000,
      onTick: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
      },
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    await ticker.stop();
  });
});

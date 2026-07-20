// 测试随机待机调度读取最新配置、跳过无动作分组并能可靠停止。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRandomIdleScheduler } from '../src/composables/random-idle.js';

describe('Random idle scheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('每轮读取最新分组与动作数量', () => {
    vi.useFakeTimers();
    const playMotion = vi.fn();
    let config = { group: 'Idle', motionCount: 0, minDelayMs: 1_000, maxDelayMs: 1_000 };
    const stop = startRandomIdleScheduler({
      playMotion,
      readConfig: () => config,
      readEnabled: () => true,
    });

    vi.advanceTimersByTime(1_000);
    expect(playMotion).not.toHaveBeenCalled();

    config = { group: 'SpecialIdle', motionCount: 2, minDelayMs: 1_000, maxDelayMs: 1_000 };
    vi.advanceTimersByTime(1_000);
    expect(playMotion).toHaveBeenCalledWith('SpecialIdle', expect.any(Number));

    stop();
    vi.advanceTimersByTime(5_000);
    expect(playMotion).toHaveBeenCalledTimes(1);
  });
});

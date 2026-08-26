// 测试待机调度只播放显式候选，并在暂停时跳过当轮。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLive2DIdleMotionSchedule } from '../idleMotion.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startLive2DIdleMotionSchedule', () => {
  it('12 秒后播放明确候选', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const play = vi.fn();
    const stop = startLive2DIdleMotionSchedule(
      play,
      () => [{ group: 'Idle', index: 0 }],
      () => true,
    );

    vi.advanceTimersByTime(12_000);
    expect(play).toHaveBeenCalledWith({ group: 'Idle', index: 0 });
    stop();
  });

  it('宿主暂停时跳过本轮，恢复后继续调度', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const play = vi.fn();
    let enabled = false;
    const stop = startLive2DIdleMotionSchedule(
      play,
      () => [{ group: 'Idle' }],
      () => enabled,
    );

    vi.advanceTimersByTime(12_000);
    expect(play).not.toHaveBeenCalled();
    enabled = true;
    vi.advanceTimersByTime(12_000);
    expect(play).toHaveBeenCalledOnce();
    stop();
  });
});

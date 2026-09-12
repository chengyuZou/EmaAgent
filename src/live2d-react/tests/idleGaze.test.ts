// 测试待机视线只在宿主判定无交互时写入归一化注视点，且范围受限。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLive2DIdleGaze } from '../idleGaze.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startLive2DIdleGaze', () => {
  it('到点且宿主允许时写入范围内注视点', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const setFocus = vi.fn();
    const stop = startLive2DIdleGaze(setFocus, () => true);

    vi.advanceTimersByTime(2_750); // 0.5 随机 → 1000 + 1750
    expect(setFocus).toHaveBeenCalledOnce();
    const [x, y] = setFocus.mock.calls[0]!;
    expect(x).toBeGreaterThanOrEqual(-0.9);
    expect(x).toBeLessThanOrEqual(0.9);
    expect(y).toBeGreaterThanOrEqual(-0.5);
    expect(y).toBeLessThanOrEqual(0.6);
    stop();
  });

  it('宿主有鼠标活动时跳过本轮，恢复后继续游移', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const setFocus = vi.fn();
    let idle = false;
    const stop = startLive2DIdleGaze(setFocus, () => idle);

    vi.advanceTimersByTime(1_000);
    expect(setFocus).not.toHaveBeenCalled();

    idle = true;
    vi.advanceTimersByTime(1_000);
    expect(setFocus).toHaveBeenCalledOnce();
    stop();
  });

  it('停止后不再调度', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const setFocus = vi.fn();
    const stop = startLive2DIdleGaze(setFocus, () => true);

    stop();
    vi.advanceTimersByTime(60_000);
    expect(setFocus).not.toHaveBeenCalled();
  });
});

// 测试 Cubism 秒时间戳到插件毫秒时间的单一转换、钳制与帧率无关系数。
import { describe, expect, it } from 'vitest';
import {
  ActiveFrameTimeline,
  FrameClock,
  frameRateIndependentFactor,
} from '../composables/frame-timing.js';

describe('FrameClock', () => {
  it('把 Cubism 秒时间戳转换为毫秒帧间隔', () => {
    const clock = new FrameClock();

    expect(clock.advance(10)).toEqual({ deltaMs: 0, elapsedMs: 0 });
    const frame = clock.advance(10.016);
    expect(frame.deltaMs).toBeCloseTo(16);
    expect(frame.elapsedMs).toBeCloseTo(16);
  });

  it('长时间休眠后单帧最多推进 100ms', () => {
    const clock = new FrameClock();
    clock.advance(1);

    expect(clock.advance(31)).toEqual({ deltaMs: 100, elapsedMs: 100 });
  });

  it('时间戳回退或无效时不产生负数与 NaN', () => {
    const clock = new FrameClock();
    clock.advance(10);

    expect(clock.advance(9)).toEqual({ deltaMs: 0, elapsedMs: 0 });
    expect(clock.advance(Number.NaN)).toEqual({ deltaMs: 0, elapsedMs: 0 });
  });
});

describe('ActiveFrameTimeline', () => {
  it('恢复首帧丢弃隐藏时长，下一帧继续正常推进', () => {
    const timeline = new ActiveFrameTimeline();

    expect(timeline.advance(10)).toBe(10);
    expect(timeline.advance(10.016)).toBeCloseTo(10.016);

    timeline.setSuspended(true);
    timeline.setSuspended(false);
    expect(timeline.advance(70)).toBeCloseTo(10.016);
    expect(timeline.advance(70.016)).toBeCloseTo(10.032);
  });
});

describe('frameRateIndependentFactor', () => {
  it('60 FPS 一帧保持原系数，两帧合并得到相同指数平滑效果', () => {
    const oneFrame = 1_000 / 60;
    const factor = frameRateIndependentFactor(0.35, oneFrame);
    const twoFrames = frameRateIndependentFactor(0.35, oneFrame * 2);

    expect(factor).toBeCloseTo(0.35);
    expect(twoFrames).toBeCloseTo(1 - (1 - 0.35) ** 2);
  });
});

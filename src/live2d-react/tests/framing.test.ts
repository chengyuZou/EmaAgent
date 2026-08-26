// 测试 Live2D 始终按模型真实边界计算稳定的默认半身构图。

import { describe, expect, it } from 'vitest';
import { calculateLive2DPlacement } from '../framing.js';

const MODEL_BOUNDS = {
  x: -40,
  y: 20,
  width: 800,
  height: 1_600,
};

describe('calculateLive2DPlacement', () => {
  it('相同舞台重复计算得到相同布局', () => {
    const first = calculateLive2DPlacement({ width: 600, height: 900 }, MODEL_BOUNDS);
    const second = calculateLive2DPlacement({ width: 600, height: 900 }, MODEL_BOUNDS);

    expect(first).toEqual(second);
    expect(first?.scale).toBeCloseTo(1.1625);
  });

  it('非零边界原点也能居中真实可见内容', () => {
    const placement = calculateLive2DPlacement(
      { width: 800, height: 1_000 },
      MODEL_BOUNDS,
    );
    expect(placement).not.toBeNull();

    const visibleLeft = placement!.x + MODEL_BOUNDS.x * placement!.scale;
    const visibleWidth = MODEL_BOUNDS.width * placement!.scale;
    expect(visibleLeft).toBeCloseTo((800 - visibleWidth) / 2);
  });

  it('舞台或模型边界无效时不产生 Infinity', () => {
    expect(calculateLive2DPlacement({ width: 0, height: 900 }, MODEL_BOUNDS)).toBeNull();
    expect(calculateLive2DPlacement(
      { width: 600, height: 900 },
      { ...MODEL_BOUNDS, width: Number.NaN },
    )).toBeNull();
  });
});

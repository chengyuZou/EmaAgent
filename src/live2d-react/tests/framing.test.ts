// 测试 Live2D resize 始终基于自然边界计算，不受上一次 scale 影响。
import { describe, expect, it } from 'vitest';
import { calculateLive2DFraming } from '../framing.js';

const NATURAL_BOUNDS = {
  x: -40,
  y: 20,
  width: 800,
  height: 1_600,
};

describe('Live2D framing', () => {
  it('相同窗口尺寸重复计算得到完全相同的 halfbody 布局', () => {
    const first = calculateLive2DFraming(
      { width: 600, height: 900 },
      NATURAL_BOUNDS,
      'halfbody',
    );
    const second = calculateLive2DFraming(
      { width: 600, height: 900 },
      NATURAL_BOUNDS,
      'halfbody',
    );

    expect(first).toEqual(second);
    expect(first?.scale).toBeCloseTo(1.1625);
  });

  it('窗口缩小再恢复时回到原始 fullbody 布局', () => {
    const original = calculateLive2DFraming(
      { width: 900, height: 1_200 },
      NATURAL_BOUNDS,
      'fullbody',
    );
    const smaller = calculateLive2DFraming(
      { width: 450, height: 600 },
      NATURAL_BOUNDS,
      'fullbody',
    );
    const restored = calculateLive2DFraming(
      { width: 900, height: 1_200 },
      NATURAL_BOUNDS,
      'fullbody',
    );

    expect(smaller?.scale).toBeLessThan(original?.scale ?? 0);
    expect(restored).toEqual(original);
  });

  it('非零 local bounds 原点也能正确居中可见内容', () => {
    const placement = calculateLive2DFraming(
      { width: 800, height: 1_000 },
      NATURAL_BOUNDS,
      'fullbody',
    );
    expect(placement).not.toBeNull();

    const visibleLeft = placement!.x + NATURAL_BOUNDS.x * placement!.scale;
    const visibleWidth = NATURAL_BOUNDS.width * placement!.scale;
    expect(visibleLeft).toBeCloseTo((800 - visibleWidth) / 2);
  });

  it('窗口或模型边界无效时保持现有舞台，不产生 Infinity scale', () => {
    expect(calculateLive2DFraming(
      { width: 0, height: 900 },
      NATURAL_BOUNDS,
      'halfbody',
    )).toBeNull();
    expect(calculateLive2DFraming(
      { width: 600, height: 900 },
      { ...NATURAL_BOUNDS, width: Number.NaN },
      'halfbody',
    )).toBeNull();
  });
});

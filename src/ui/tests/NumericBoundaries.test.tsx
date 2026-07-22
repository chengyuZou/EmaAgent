// 测试进度、选项卡、滑块和主题设置面对非法数字与空集合的行为。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Progress } from '../components/Progress.js';
import { Slider } from '../components/Slider.js';
import { Tabs } from '../components/Tabs.js';
import {
  getThemeHue,
  getThemeRadius,
  resetThemeHue,
  resetThemeRadius,
  setThemeHue,
  setThemeRadius,
} from '../utils/theme.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetThemeHue();
  resetThemeRadius();
  vi.restoreAllMocks();
});

describe('numeric component boundaries', () => {
  it('normalizes non-finite progress to zero', () => {
    act(() => root.render(<Progress progress={Number.NaN} />));

    const progressbar = container.querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(progressbar.getAttribute('aria-valuenow')).toBe('0');
    expect(progressbar.querySelector<HTMLElement>('[style]')?.style.width).toBe('0%');
  });

  it('does not create a sliding indicator for empty or unknown tabs', () => {
    act(() => root.render(<Tabs value="missing" onChange={vi.fn()} items={[]} />));
    const emptyList = container.querySelector<HTMLElement>('[role="tablist"]')!;
    expect(emptyList.style.getPropertyValue('--tab-count')).toBe('');
    expect(emptyList.className).not.toContain('ema-tab-slider');

    act(() => root.render(
      <Tabs
        value="missing"
        onChange={vi.fn()}
        items={[{ value: 'known', label: 'Known', content: 'Content' }]}
      />,
    ));
    const unknownList = container.querySelector<HTMLElement>('[role="tablist"]')!;
    expect(unknownList.style.getPropertyValue('--tab-active-index')).toBe('');
    expect(unknownList.className).not.toContain('ema-tab-slider');
  });

  it('renders an explicitly disabled slider when no valid steps remain', () => {
    act(() => root.render(
      <Slider
        value={Number.NaN}
        onChange={vi.fn()}
        steps={[{ value: Number.NaN, label: 'Invalid' }]}
      />,
    ));

    const slider = container.querySelector<HTMLElement>('[role="slider"]');
    expect(slider).toBeNull();
    expect(container.querySelector('[data-empty="true"]')).not.toBeNull();
  });
});

describe('theme numeric boundaries', () => {
  it('falls back instead of writing NaN or Infinity to CSS variables', () => {
    setThemeHue(Number.NaN);
    setThemeRadius(Number.POSITIVE_INFINITY);

    expect(getThemeHue()).toBe(200);
    expect(getThemeRadius()).toBe(1);
    expect(document.documentElement.style.cssText).not.toContain('NaN');
    expect(document.documentElement.style.cssText).not.toContain('Infinity');
  });
});

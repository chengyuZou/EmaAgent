// 测试只读预览卡片通过键盘聚焦打开到 Portal, 且不沿用短标签的反色和箭头.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tooltip, TooltipProvider } from '../components/Tooltip.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // JSDOM 不实现尺寸观察, 这里仅验证 Portal 和内容分支, 实际尺寸在浏览器验收.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Tooltip', () => {
  it('opens a preview card outside its trigger container on keyboard focus', async () => {
    act(() => root.render(
      <TooltipProvider>
        <Tooltip variant="card" content={<p>上下文窗口: 18% 已用</p>}>
          <button type="button">上下文用量</button>
        </Tooltip>
      </TooltipProvider>,
    ));
    const trigger = container.querySelector('button')!;
    await act(async () => trigger.focus());

    const card = document.querySelector('.ema-tooltip-card')!;
    expect(card).not.toBeNull();
    expect(container.contains(card)).toBe(false);
    expect(card.textContent).toContain('18% 已用');
    expect(card.className).not.toContain('bg-[var(--ema-text-primary)]');
    expect(card.querySelector('.ema-tooltip-arrow')).toBeNull();
    expect(trigger.hasAttribute('title')).toBe(false);
  });

  it('keeps the inverse surface and arrow for short labels by default', async () => {
    act(() => root.render(
      <TooltipProvider>
        <Tooltip content="复制">
          <button type="button">复制消息</button>
        </Tooltip>
      </TooltipProvider>,
    ));
    await act(async () => container.querySelector('button')!.focus());

    const label = document.querySelector('.ema-tooltip-surface')!;
    expect(label).not.toBeNull();
    expect(label.className).toContain('bg-[var(--ema-text-primary)]');
    expect(label.querySelector('.ema-tooltip-arrow')).not.toBeNull();
    expect(label.className).not.toContain('ema-tooltip-card');
  });
});

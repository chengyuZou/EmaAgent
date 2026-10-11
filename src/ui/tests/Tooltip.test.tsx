// 测试只读预览卡片通过键盘聚焦打开到 Portal, 且不沿用短标签的反色和箭头.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tooltip, TooltipProvider } from '../components/Tooltip.js';
import { DropdownMenu } from '../components/DropdownMenu.js';
import { Popover } from '../components/Popover.js';

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Tooltip', () => {
  it.each([undefined, null, ''])('leaves the child unchanged when content is %s', (content) => {
    act(() => root.render(
      <Tooltip content={content}>
        <button type="button">没有提示</button>
      </Tooltip>,
    ));
    expect(container.children).toHaveLength(1);
    expect(container.querySelector('button')?.hasAttribute('data-state')).toBe(false);
    expect(document.querySelector('.ema-tooltip-surface')).toBeNull();
  });

  it('uses the provider hover delay when the caller does not override it', async () => {
    vi.useFakeTimers();
    act(() => root.render(
      <TooltipProvider delayDuration={80}>
        <Tooltip content="刷新">
          <button type="button">刷新网页</button>
        </Tooltip>
      </TooltipProvider>,
    ));
    const trigger = container.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(79);
    });
    expect(document.querySelector('.ema-tooltip-surface')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(document.querySelector('.ema-tooltip-surface')?.textContent).toContain('刷新');
  });

  it('allows a caller to choose a shorter hover delay', async () => {
    vi.useFakeTimers();
    act(() => root.render(
      <TooltipProvider delayDuration={200}>
        <Tooltip content="Turn 预览" delayDuration={120}>
          <button type="button">Turn 导航</button>
        </Tooltip>
      </TooltipProvider>,
    ));
    await act(async () => {
      container.querySelector('button')!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(document.querySelector('.ema-tooltip-surface')?.textContent).toContain('Turn 预览');
  });

  it('keeps dropdown keyboard opening, selection and focus return when the trigger has a tooltip', async () => {
    const select = vi.fn();
    act(() => root.render(
      <TooltipProvider>
        <DropdownMenu
          trigger={<button type="button">选择模型</button>}
          triggerTooltip="当前模型的完整名称"
          items={[{ kind: 'item', label: '测试模型', onSelect: select }]}
        />
      </TooltipProvider>,
    ));
    const trigger = container.querySelector('button')!;
    await act(async () => trigger.focus());
    expect(document.querySelector('.ema-tooltip-label')?.textContent).toContain('当前模型的完整名称');
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const item = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(item).not.toBeNull();
    await act(async () => {
      item.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // FocusScope 在浮层卸载后用计时器恢复焦点, 必须先让 React 完成卸载.
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(trigger);
    expect(trigger.hasAttribute('title')).toBe(false);
    expect(container.children).toHaveLength(1);
  });

  it('keeps popover click opening and Escape closing when the trigger has a tooltip', async () => {
    act(() => root.render(
      <TooltipProvider>
        <Popover trigger={<button type="button">摘要</button>} triggerTooltip="置顶摘要">
          <p>当前会话摘要</p>
        </Popover>
      </TooltipProvider>,
    ));
    const trigger = container.querySelector('button')!;
    await act(async () => trigger.focus());
    expect(document.querySelector('.ema-tooltip-label')?.textContent).toContain('置顶摘要');
    await act(async () => {
      trigger.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog?.textContent).toContain('当前会话摘要');
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(trigger);
    expect(container.children).toHaveLength(1);
  });

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

  it('uses the shared label surface and arrow for short labels by default', async () => {
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
    expect(label.className).toContain('ema-tooltip-label');
    expect(label.querySelector('.ema-tooltip-arrow')).not.toBeNull();
    expect(label.className).not.toContain('ema-tooltip-card');
  });
});

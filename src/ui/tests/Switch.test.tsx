// 测试 Switch 点击后同步更新语义状态，并把滑块移动到轨道右侧。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Switch } from '../components/Switch.js';

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
});

describe('Switch', () => {
  it('moves the thumb to the right when enabled', () => {
    act(() => {
      root.render(<Switch defaultChecked={false} label="启用测试能力" />);
    });

    const control = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    const thumb = control.firstElementChild as HTMLSpanElement;
    expect(control.dataset.state).toBe('unchecked');
    expect(thumb.dataset.state).toBe('unchecked');

    act(() => control.click());

    expect(control.dataset.state).toBe('checked');
    expect(thumb.dataset.state).toBe('checked');
    expect(thumb.className).toContain('data-[state=checked]:translate-x-full');
  });
});

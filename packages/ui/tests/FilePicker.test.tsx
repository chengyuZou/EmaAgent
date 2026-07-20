// 测试 FilePicker 的按钮组合、禁用态和文件选择回调。
import { act, type MouseEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../src/components/Button.js';
import { FilePicker } from '../src/components/FilePicker.js';

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
  vi.restoreAllMocks();
});

describe('FilePicker', () => {
  it('enhances one trigger button without creating nested buttons', () => {
    const inputClick = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => undefined);

    act(() => {
      root.render(
        <FilePicker onSelect={vi.fn()} className="picker-class">
          <Button className="trigger-class">选择文件</Button>
        </FilePicker>,
      );
    });

    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(container.querySelector('button button')).toBeNull();
    expect(buttons[0]!.className).toContain('picker-class');
    expect(buttons[0]!.className).toContain('trigger-class');

    act(() => buttons[0]!.click());
    expect(inputClick).toHaveBeenCalledOnce();
  });

  it('respects prevented clicks and the disabled state', () => {
    const inputClick = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const preventOpen = vi.fn((event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
    });

    act(() => {
      root.render(
        <FilePicker onSelect={vi.fn()}>
          <Button onClick={preventOpen}>选择文件</Button>
        </FilePicker>,
      );
    });
    act(() => container.querySelector('button')!.click());
    expect(preventOpen).toHaveBeenCalledOnce();
    expect(inputClick).not.toHaveBeenCalled();

    act(() => {
      root.render(
        <FilePicker onSelect={vi.fn()} disabled>
          <Button>选择文件</Button>
        </FilePicker>,
      );
    });
    expect(container.querySelector('button')!.disabled).toBe(true);
    expect(container.querySelector('input')!.disabled).toBe(true);
  });

  it('returns selected files and clears the native input value', () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(
        <FilePicker onSelect={onSelect} multiple>
          <Button>选择文件</Button>
        </FilePicker>,
      );
    });

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const first = new File(['first'], 'first.txt', { type: 'text/plain' });
    const second = new File(['second'], 'second.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [first, second],
    });
    Object.defineProperty(input, 'value', {
      configurable: true,
      writable: true,
      value: 'selected',
    });

    act(() => input.dispatchEvent(new Event('change', { bubbles: true })));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith([first, second]);
    expect(input.value).toBe('');
  });
});

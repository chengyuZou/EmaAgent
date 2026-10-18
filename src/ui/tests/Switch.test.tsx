import { readFileSync } from 'node:fs';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Switch } from '../components/Switch.js';
import { Tooltip, TooltipProvider } from '../components/Tooltip.js';

let container: HTMLDivElement;
let root: Root;
let stylesheet: HTMLStyleElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stylesheet = document.createElement('style');
  stylesheet.textContent = readFileSync('styles/primitives/radix.css', 'utf8');
  document.head.appendChild(stylesheet);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  stylesheet.remove();
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
    expect(getComputedStyle(thumb).transform).toBe('translateX(2px) scale(1)');

    act(() => control.click());

    expect(control.dataset.state).toBe('checked');
    expect(thumb.dataset.state).toBe('checked');
    expect(getComputedStyle(thumb).transform).toBe('translateX(24px) scale(1)');

    act(() => control.click());

    expect(control.dataset.state).toBe('unchecked');
    expect(thumb.dataset.state).toBe('unchecked');
    expect(getComputedStyle(thumb).transform).toBe('translateX(2px) scale(1)');
  });

  it('forwards the tooltip trigger ref to its button', () => {
    const ref = createRef<HTMLButtonElement>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => {
      root.render(
        <TooltipProvider>
          <Tooltip content="启用技能">
            <Switch ref={ref} defaultChecked={false} label="测试技能" />
          </Tooltip>
        </TooltipProvider>,
      );
    });

    expect(ref.current).toBe(container.querySelector('[role="switch"]'));
    expect(consoleError.mock.calls.flat().join('\n')).not.toContain('Function components cannot be given refs');
    consoleError.mockRestore();
  });
});

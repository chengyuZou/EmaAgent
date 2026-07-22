// 测试 Combobox 的禁用项导航、筛选状态与 ARIA 关联。
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Combobox,
  deriveActiveIndex,
  firstEnabledIndex,
  lastEnabledIndex,
  nextEnabledIndex,
  type ComboboxOption,
} from '../components/Combobox.js';

vi.mock('../components/Popover.js', () => ({
  Popover: ({
    trigger,
    children,
    open,
  }: {
    trigger: ReactNode;
    children: ReactNode;
    open?: boolean;
  }) => (
    <div>
      {trigger}
      {open ? children : null}
    </div>
  ),
}));

const options: ComboboxOption[] = [
  { value: 'alpha', label: 'Alpha', disabled: true },
  { value: 'beta', label: 'Beta' },
  { value: 'gamma', label: 'Gamma' },
];

let container: HTMLDivElement;
let root: Root;

function activeOption(input: HTMLInputElement): HTMLElement | null {
  const optionId = input.getAttribute('aria-activedescendant');
  return optionId ? document.getElementById(optionId) : null;
}

function press(input: HTMLInputElement, key: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    }));
  });
}

function typeQuery(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;

  act(() => {
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('Combobox navigation helpers', () => {
  it('finds enabled options and skips disabled options while wrapping', () => {
    expect(firstEnabledIndex(options)).toBe(1);
    expect(lastEnabledIndex(options)).toBe(2);
    expect(nextEnabledIndex(options, 1, 1)).toBe(2);
    expect(nextEnabledIndex(options, 2, 1)).toBe(1);
    expect(nextEnabledIndex(options, 1, -1)).toBe(2);
    expect(deriveActiveIndex(options, 0)).toBe(1);
  });

  it('returns no active option when every option is disabled', () => {
    const disabledOptions = options.map((option) => ({ ...option, disabled: true }));

    expect(firstEnabledIndex(disabledOptions)).toBe(-1);
    expect(lastEnabledIndex(disabledOptions)).toBe(-1);
    expect(nextEnabledIndex(disabledOptions, -1, 1)).toBe(-1);
    expect(deriveActiveIndex(disabledOptions, 0)).toBe(-1);
  });
});

describe('Combobox interactions', () => {
  it('keeps keyboard focus on enabled options and exposes the active option to assistive technology', () => {
    const onChange = vi.fn();
    act(() => root.render(<Combobox options={options} onChange={onChange} />));

    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => input.focus());

    const listboxId = input.getAttribute('aria-controls');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(listboxId).not.toBeNull();
    expect(document.getElementById(listboxId!)).not.toBeNull();
    expect(activeOption(input)?.textContent).toContain('Beta');

    press(input, 'ArrowDown');
    expect(activeOption(input)?.textContent).toContain('Gamma');

    press(input, 'ArrowDown');
    expect(activeOption(input)?.textContent).toContain('Beta');

    const disabledOption = container.querySelector<HTMLElement>('[aria-disabled="true"]')!;
    act(() => {
      disabledOption.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(activeOption(input)?.textContent).toContain('Beta');

    press(input, 'Enter');
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('beta');
  });

  it('resets the active option after filtering', () => {
    act(() => root.render(<Combobox options={options} onChange={vi.fn()} />));

    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => input.focus());
    press(input, 'ArrowDown');
    expect(activeOption(input)?.textContent).toContain('Gamma');

    typeQuery(input, 'be');
    expect(activeOption(input)?.textContent).toContain('Beta');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
  });
});

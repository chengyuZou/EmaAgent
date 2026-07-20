// 测试 Dialog 与 Field 的名称、说明、必填状态和错误关联。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../src/components/Dialog.js';
import { Field } from '../src/components/Field.js';
import { Input } from '../src/components/Input.js';

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

describe('Dialog accessibility', () => {
  it('uses the visible title as the dialog name', () => {
    act(() => {
      root.render(
        <Dialog open onOpenChange={vi.fn()} title="确认删除">
          <button type="button">确认</button>
        </Dialog>,
      );
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const titleId = dialog.getAttribute('aria-labelledby');
    expect(titleId).not.toBeNull();
    expect(document.getElementById(titleId!)?.textContent).toBe('确认删除');
  });

  it('supports a non-visual accessible name for custom dialog content', () => {
    act(() => {
      root.render(
        <Dialog open onOpenChange={vi.fn()} ariaLabel="角色卡编辑器">
          <button type="button">保存</button>
        </Dialog>,
      );
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const titleId = dialog.getAttribute('aria-labelledby');
    expect(document.getElementById(titleId!)?.textContent).toBe('角色卡编辑器');
  });
});

describe('Field accessibility', () => {
  it('connects its label, description and error to the control', () => {
    act(() => {
      root.render(
        <Field
          label="API Key"
          description="由供应商提供"
          error="API Key 无效"
          required
        >
          <Input aria-describedby="external-hint" />
        </Field>,
      );
    });

    const input = container.querySelector('input')!;
    const label = container.querySelector('label')!;
    const describedBy = input.getAttribute('aria-describedby')!.split(' ');
    const errorId = input.getAttribute('aria-errormessage');

    expect(input.id).not.toBe('');
    expect(label.htmlFor).toBe(input.id);
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy).toContain('external-hint');
    expect(describedBy).toContain(errorId);
    expect(document.getElementById(errorId!)?.textContent).toBe('API Key 无效');
    expect(describedBy.some((id) => document.getElementById(id)?.textContent === '由供应商提供'))
      .toBe(true);
  });
});

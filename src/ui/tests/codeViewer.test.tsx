// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeViewer } from '../components/codeViewer.js';
import { TooltipProvider } from '../components/Tooltip.js';

let host: HTMLDivElement;
let root: Root;
const clipboard = vi.fn();
const originalRects = Range.prototype.getClientRects;
const originalBounds = Range.prototype.getBoundingClientRect;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  // JSDOM 不计算文本尺寸, 这里只验证文档和生命周期; 真实滚动在浏览器验证.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
  clipboard.mockReset().mockResolvedValue(undefined);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Range.prototype.getClientRects = originalRects;
  Range.prototype.getBoundingClientRect = originalBounds;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function editor(): EditorView {
  return EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
}

describe('CodeViewer', () => {
  it('内嵌时没有第二份工具栏, 保留完整只读文本和原位更新', async () => {
    const source = '超长单行'.repeat(20_000);
    await act(async () => root.render(<CodeViewer source={source} embedded />));
    const view = editor();
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.readOnly).toBe(true);
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).not.toContain('文本 · 只读');
    await act(async () => root.render(<CodeViewer source='{"ok":true}' language="json" embedded />));
    expect(editor()).toBe(view);
    expect(view.state.doc.toString()).toBe('{"ok":true}');
    const destroy = vi.spyOn(view, 'destroy');
    await act(async () => root.render(null));
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('独立查看器保留一个复制按钮, 复制完整原文并提供失败反馈', async () => {
    const source = '正文\n'.repeat(25_000);
    await act(async () => root.render(
      <TooltipProvider><CodeViewer source={source} /></TooltipProvider>,
    ));
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(host.textContent).toContain('文本 · 只读');
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(clipboard).toHaveBeenCalledWith(source);
    clipboard.mockRejectedValueOnce(new Error('denied'));
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain('复制失败');
  });
});

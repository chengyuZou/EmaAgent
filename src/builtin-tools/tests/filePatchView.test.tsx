// @vitest-environment jsdom
// 官方补丁类型和序列化能被 Diff 组件解析; Edit/Write 共用视图并跟随页面主题.
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePatch } from 'diff';
import { parsePatchFiles } from '@pierre/diffs';
import { preloadPatchDiff } from '@pierre/diffs/ssr';
import type { PatchDiffProps } from '@pierre/diffs/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEditResult } from '../tools/FileEditTool/FileEditTool.js';
import type { FileWriteResult } from '../tools/FileWriteTool/FileWriteTool.js';
import { FileEditResultView } from '../tools/FileEditTool/UI.js';
import { FileWriteResultView } from '../tools/FileWriteTool/UI.js';
import { buildStructuredPatch, patchToUnifiedText } from '../tools/FileEditTool/patch.js';

const diffView = vi.hoisted(() => vi.fn());
vi.mock('@pierre/diffs/react', () => ({ PatchDiff: diffView }));
vi.mock('@ema-agent/ui', () => ({
  Badge: ({ children }: { children: ReactNode }) => createElement('span', {}, children),
}));

let host: HTMLDivElement;
let root: Root;
const filePath = 'C:\\项目 空格\\usage.ts';
const before = 'const input = Math.min(100, 90);\n';
const after = 'const input = Math.max(100, 90);';
const edit: FileEditResult = {
  filePath,
  oldString: 'Math.min',
  newString: 'Math.max',
  originalFile: before,
  structuredPatch: buildStructuredPatch(filePath, before, after),
  additions: 1,
  deletions: 1,
  replaceAll: false,
  replacements: 1,
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  document.documentElement.dataset.theme = 'light';
  diffView.mockImplementation(() => createElement('div', { 'data-test-diff': true }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

function currentDiff(): PatchDiffProps<undefined, undefined> {
  return diffView.mock.calls.at(-1)![0];
}

describe('内置 Tool 的官方补丁视图', () => {
  it.each(['light', 'dark'])('%s 主题的官方 shadow 样式使用透明底和产品增删颜色', async (theme) => {
    document.documentElement.dataset.theme = theme;
    await act(async () => root.render(createElement(FileEditResultView, { data: edit })));
    const rendered = await preloadPatchDiff(currentDiff());
    const container = document.createElement('div');
    container.innerHTML = rendered.prerenderedHTML;
    const css = [...container.querySelectorAll('style')].map((style) => style.textContent).join('\n');
    expect(/--diffs-bg:\s*transparent/.test(css)).toBe(true);
    expect(/--diffs-bg-addition-override:\s*var\(--ema-success-muted\)/.test(css)).toBe(true);
    expect(/--diffs-bg-deletion-override:\s*var\(--ema-danger-muted\)/.test(css)).toBe(true);
  });

  it.each(['edit', 'updated', 'created'] as const)('%s 正文不预留复制按钮的右侧空栏, 仅摘要行预留', async (kind) => {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve('../../apps/desktop/src/styles/domains/toolRow.css'), 'utf8');
    document.head.append(style);
    host.className = 'ema-tool-pane-content';
    try {
      let view: ReactNode;
      if (kind === 'edit') {
        view = createElement(FileEditResultView, { data: edit });
      } else {
        const write: FileWriteResult = {
          type: kind, filePath, content: after, bytesWritten: after.length,
          originalFile: kind === 'created' ? null : before,
          structuredPatch: kind === 'created' ? [] : edit.structuredPatch,
          additions: 1, deletions: kind === 'created' ? 0 : 1,
        };
        view = createElement(FileWriteResultView, { data: write });
      }
      await act(async () => root.render(view));
      expect(getComputedStyle(host).paddingRight).toBe('0px');
      const summary = host.querySelector('.ema-file-change-summary')!;
      expect(summary).not.toBeNull();
      expect(getComputedStyle(summary).paddingRight).toBe('25px');
      await act(async () => root.render(createElement('div', {}, '普通输出')));
      expect(getComputedStyle(host).paddingRight).toBe('25px');
    } finally {
      style.remove();
    }
  });

  it('中文、空格与 Windows 路径通过官方格式化和解析, 保留无末尾换行信息', async () => {
    await act(async () => root.render(createElement(FileEditResultView, { data: edit })));
    const view = currentDiff();
    const file = parsePatchFiles(view.patch)[0]!.files[0]!;
    expect(file.name).toBe('C:/项目 空格/usage.ts');
    expect(file.additionLines.join('')).toContain('Math.max');
    expect(file.deletionLines.join('')).toContain('Math.min');
    expect(view.patch).toContain('\\ No newline at end of file');
    expect(view.options?.diffStyle).toBe('unified');
    expect(view.options?.disableFileHeader).toBe(true);
  });

  it('官方高亮渲染使用单列行号, 不是手写 Diff 行', async () => {
    await act(async () => root.render(createElement(FileEditResultView, { data: edit })));
    const rendered = await preloadPatchDiff(currentDiff());
    const container = document.createElement('div');
    container.innerHTML = rendered.prerenderedHTML;
    const numbers = container.querySelectorAll('[data-column-number]');
    expect(numbers.length).toBeGreaterThan(0);
    for (const number of numbers) {
      expect(number.querySelectorAll('[data-line-number-content]')).toHaveLength(1);
    }
    expect(container.querySelector('[data-line] span')).not.toBeNull();
  });

  it('覆盖 Write 使用同一补丁组件, 新建文件仍然显示内容预览', async () => {
    const write: FileWriteResult = {
      type: 'updated', filePath, content: after, originalFile: before,
      bytesWritten: after.length, structuredPatch: edit.structuredPatch,
      additions: 1, deletions: 1,
    };
    await act(async () => root.render(createElement(FileWriteResultView, { data: write })));
    expect(host.textContent).toContain('已覆盖写入');
    expect(parsePatchFiles(currentDiff().patch)[0]!.files).toHaveLength(1);
    diffView.mockClear();
    await act(async () => root.render(createElement(FileWriteResultView, {
      data: { ...write, type: 'created', originalFile: null, structuredPatch: [], deletions: 0 },
    })));
    expect(diffView).not.toHaveBeenCalled();
    expect(host.textContent).toContain('新建文件');
    expect(host.textContent).toContain(after);
  });

  it('跟随现有页面主题标记, 不依赖 desktop Store', async () => {
    await act(async () => root.render(createElement(FileEditResultView, { data: edit })));
    expect(currentDiff().options?.themeType).toBe('light');
    await act(async () => {
      document.documentElement.dataset.theme = 'dark';
      await Promise.resolve();
    });
    expect(currentDiff().options?.themeType).toBe('dark');
  });

  it('复制正文由 formatPatch 生成, 正确处理零行起点和无末尾换行', () => {
    const hunks = buildStructuredPatch('new.ts', '', 'const value = 1;');
    const text = patchToUnifiedText(hunks);
    const parsed = parsePatch(`--- old.ts\n+++ new.ts\n${text}`)[0]!;
    expect(parsed.hunks).toEqual(hunks);
    expect(text).toContain('@@ -0,0 +1,1 @@');
    expect(text).toContain('\\ No newline at end of file');
  });
});

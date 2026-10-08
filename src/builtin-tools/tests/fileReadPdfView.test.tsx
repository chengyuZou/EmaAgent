// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileReadArgsView,
  FileReadResultView,
  fileReadResultCopyText,
} from '../tools/FileReadTool/UI.js';
import type { PdfReadResult } from '../tools/FileReadTool/pdfReader.js';

vi.mock('@ema-agent/ui', () => ({
  Badge: ({ children }: { children: ReactNode }) => createElement('span', {}, children),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Read PDF 结果展示', () => {
  it('页码参数按页展示, 不当作文本行号', async () => {
    await act(async () => root.render(createElement(FileReadArgsView, {
      args: { file_path: 'docs/report.pdf', start_page: 3, page_count: 2 },
    })));
    expect(host.textContent).toContain('第 3–4 页');
    expect(host.textContent).not.toContain('行');
  });

  it('显示正文、实际缺失原因和续读位置, 复制仍返回正文', async () => {
    const data: PdfReadResult = {
      type: 'pdf_content',
      filePath: 'docs/report.pdf',
      content: '## Page 3\n\n可读正文',
      startPage: 3,
      endPage: 4,
      totalPages: 7,
      nextPage: 5,
      warnings: [{
        page: 4,
        code: 'pdf/ocr-unavailable',
        message: '当前未配置 PDF OCR 能力',
        retryable: false,
      }],
    };
    await act(async () => root.render(createElement(FileReadResultView, { data })));
    expect(host.textContent).toContain('第 3–4 页 · 共 7 页');
    expect(host.textContent).toContain('可继续读取第 5 页');
    expect(host.textContent).toContain('第 4 页: 当前未配置 PDF OCR 能力');
    expect(host.textContent).toContain('可读正文');
    expect(fileReadResultCopyText(data)).toBe(data.content);
  });

  it('无效 warnings 返回通用展示, 不让 PDF 卡片崩溃', async () => {
    await act(async () => root.render(createElement(FileReadResultView, {
      data: {
        type: 'pdf_content', filePath: 'bad.pdf', content: '',
        startPage: 1, endPage: 1, totalPages: 1, warnings: [null],
      },
    })));
    expect(host.textContent).toBe('');
  });
});

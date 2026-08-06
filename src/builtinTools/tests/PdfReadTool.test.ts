// 验证 PdfReadTool 的路径校验、页范围编排、warnings 映射与模型投影; pdfjs 用 mock 隔离。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import type { ToolInvocation } from '@ema-agent/tools';
import { PdfReadTool } from '../tools/PdfReadTool/PdfReadTool.js';

const { readRangeMock } = vi.hoisted(() => ({ readRangeMock: vi.fn() }));

vi.mock('@ema-agent/knowledge', () => ({
  PdfReader: class {
    readRange = readRangeMock;
  },
}));

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-read-tool-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  readRangeMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function invocation(): ToolInvocation {
  return Object.freeze({
    sessionId: asSessionId('session-pdf-tool'),
    turnId: asTurnId('turn-pdf-tool'),
    toolCallId: asToolCallId('toolcall-pdf-tool'),
    signal: new AbortController().signal,
  });
}

function narrowContext(workspaceRoot: string): { workspaceRoot: string } {
  const result = PdfReadTool.validateContext({ workspaceRoot } as never);
  if (!result.valid) throw new Error(result.reason);
  return result.context;
}

describe('PdfReadTool schema', () => {
  it('接受路径并允许缺省分页参数', () => {
    const input = PdfReadTool.inputSchema.parse({ file_path: 'docs/a.pdf' });
    expect(input.start_page).toBeUndefined();
    expect(input.page_count).toBeUndefined();
  });

  it('strict: 拒绝未知字段与超限页数', () => {
    expect(PdfReadTool.inputSchema.safeParse({
      file_path: 'a.pdf',
      mode: 'fast',
    }).success).toBe(false);
    expect(PdfReadTool.inputSchema.safeParse({
      file_path: 'a.pdf',
      page_count: 21,
    }).success).toBe(false);
  });
});

describe('PdfReadTool validateContext', () => {
  it('没有工作区时拒绝执行', () => {
    expect(PdfReadTool.validateContext({ workspaceRoot: '' } as never)).toEqual({
      valid: false,
      reason: 'PDF 读取工具未装配工作区。',
    });
  });

  it('有工作区时只投影窄 Context', () => {
    const result = PdfReadTool.validateContext({ workspaceRoot: 'C:\\work' } as never);
    expect(result).toEqual({ valid: true, context: { workspaceRoot: 'C:\\work' } });
  });
});

describe('PdfReadTool validateInput', () => {
  it('拒绝 UNC、设备文件与非 PDF 扩展名', async () => {
    expect((await PdfReadTool.validateInput!({ file_path: '\\\\srv\\share\\a.pdf' })).valid)
      .toBe(false);
    expect((await PdfReadTool.validateInput!({ file_path: 'notes.txt' })).valid)
      .toBe(false);
  });

  it('接受普通 .pdf 路径(扩展名大小写不敏感)', async () => {
    expect((await PdfReadTool.validateInput!({ file_path: 'Docs/A.PDF' })).valid)
      .toBe(true);
  });
});

describe('PdfReadTool execute', () => {
  it('按默认 10 页读取并映射 warnings/nextPage', async () => {
    const dir = makeDir();
    const filePath = path.join(dir, 'doc.pdf');
    fs.writeFileSync(filePath, '%PDF-1.4\n%fake-content');
    readRangeMock.mockResolvedValue({
      blocks: [{
        id: 'b1',
        kind: 'paragraph',
        text: 'Hello PDF',
        sectionPath: [],
        page: 1,
      }],
      pageCount: 12,
      failures: [{
        shardKey: 'page:3',
        errorCode: 'kb/pdf-figure-unavailable',
        error: '图表未解析',
        retryable: false,
      }],
    });

    const input = PdfReadTool.inputSchema.parse({ file_path: 'doc.pdf' });
    const result = await PdfReadTool.execute(
      input,
      narrowContext(dir),
      invocation(),
    );

    expect(result.startPage).toBe(1);
    expect(result.endPage).toBe(10);
    expect(result.totalPages).toBe(12);
    expect(result.nextPage).toBe(11);
    expect(result.warnings).toEqual([{
      page: 3,
      code: 'kb/pdf-figure-unavailable',
      message: '图表未解析',
      retryable: false,
    }]);
    expect(result.content).toContain('## Page 1\n\nHello PDF');
    expect(result.content).toContain('## Page 2\n\n[No readable text on this page]');
    expect(readRangeMock).toHaveBeenCalledWith(
      { kind: 'path', path: filePath },
      { startPage: 1, endPage: 10, signal: expect.any(AbortSignal) },
    );
  });

  it('拒绝超过体积上限的 PDF', async () => {
    const dir = makeDir();
    const filePath = path.join(dir, 'big.pdf');
    fs.writeFileSync(filePath, '%PDF-1.4');
    fs.truncateSync(filePath, 51 * 1024 * 1024);

    await expect(
      PdfReadTool.execute(
        PdfReadTool.inputSchema.parse({ file_path: 'big.pdf' }),
        narrowContext(dir),
        invocation(),
      ),
    ).rejects.toThrow(/too large/);
  });

  it('拒绝没有 PDF 签名的文件', async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'fake.pdf'), 'not-a-pdf');

    await expect(
      PdfReadTool.execute(
        PdfReadTool.inputSchema.parse({ file_path: 'fake.pdf' }),
        narrowContext(dir),
        invocation(),
      ),
    ).rejects.toThrow(/valid PDF signature/);
  });
});

describe('PdfReadTool 模型投影与摘要', () => {
  it('无 warnings 时原样返回正文', () => {
    const content = String(PdfReadTool.mapResultToModelContent!({
      type: 'pdf_content',
      filePath: 'a.pdf',
      content: '## Page 1\n\nHello',
      startPage: 1,
      endPage: 1,
      totalPages: 1,
      warnings: [],
    }));
    expect(content).toBe('## Page 1\n\nHello');
  });

  it('有 warnings 时追加读取不完整说明', () => {
    const content = String(PdfReadTool.mapResultToModelContent!({
      type: 'pdf_content',
      filePath: 'a.pdf',
      content: '## Page 1\n\nHello',
      startPage: 1,
      endPage: 1,
      totalPages: 1,
      warnings: [{
        page: 3,
        code: 'kb/pdf-figure-unavailable',
        message: '图表未解析',
        retryable: false,
      }],
    }));
    expect(content).toContain('[读取不完整]');
    expect(content).toContain('第 3 页: 图表未解析');
  });

  it('getToolUseSummary 返回文件路径', () => {
    expect(PdfReadTool.getToolUseSummary?.({ file_path: 'docs/a.pdf' }))
      .toBe('docs/a.pdf');
  });
});

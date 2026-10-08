// 验证 FileReadTool 的路径校验、页范围编排、warnings 映射与模型投影; pdfjs 用 mock 隔离。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileStateCache, type ToolInvocation } from '@ema-agent/tools';
import { FileReadTool } from '../tools/FileReadTool/FileReadTool.js';

const { readRangeMock } = vi.hoisted(() => ({ readRangeMock: vi.fn() }));

vi.mock('../tools/FileReadTool/pdfParser.js', () => ({
  PdfVisionReader: class {},
  PdfParser: class {
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
    sessionId: 'session-pdf-tool',
    turnId: 'turn-pdf-tool',
    toolCallId: 'toolcall-pdf-tool',
    signal: new AbortController().signal,
  });
}

function narrowContext(cwd: string) {
  const result = FileReadTool.validateContext({ cwd, fileStateCache: new FileStateCache() } as never);
  if (!result.valid) throw new Error(result.reason);
  return result.context;
}

describe('FileReadTool schema', () => {
  it('接受路径并允许缺省分页参数', () => {
    const input = FileReadTool.inputSchema.parse({ file_path: 'docs/a.pdf' });
    expect(input.start_page).toBeUndefined();
    expect(input.page_count).toBeUndefined();
  });

  it('strict: 拒绝未知字段与超限页数', () => {
    expect(FileReadTool.inputSchema.safeParse({
      file_path: 'a.pdf',
      mode: 'fast',
    }).success).toBe(false);
    expect(FileReadTool.inputSchema.safeParse({
      file_path: 'a.pdf',
      page_count: 21,
    }).success).toBe(false);
  });
});

describe('FileReadTool validateContext', () => {
  it('没有工作区时拒绝执行', () => {
    expect(FileReadTool.validateContext({ cwd: '' } as never)).toEqual({
      valid: false,
      reason: 'File 读取工具需要明确的工作区。',
    });
  });

});

describe('FileReadTool execute', () => {
  it('按默认 10 页读取并映射 warnings/nextPage', async () => {
    const dir = makeDir();
    const filePath = path.join(dir, 'doc.pdf');
    fs.writeFileSync(filePath, '%PDF-1.4\n%fake-content');
    readRangeMock.mockResolvedValue({
      blocks: [{
        kind: 'paragraph',
        text: 'Hello PDF',
        page: 1,
      }],
      pageCount: 12,
      failures: [{
        page: 3,
        errorCode: 'pdf/figure-unavailable',
        error: '图表未解析',
        retryable: false,
      }],
    });

    const input = FileReadTool.inputSchema.parse({ file_path: 'doc.pdf' });
    const result = await FileReadTool.execute(
      input,
      narrowContext(dir),
      invocation(),
    );

    if (result.type !== 'pdf_content') throw new Error('Expected PDF result');
    expect(result.startPage).toBe(1);
    expect(result.endPage).toBe(10);
    expect(result.totalPages).toBe(12);
    expect(result.nextPage).toBe(11);
    expect(result.warnings).toEqual([{
      page: 3,
      code: 'pdf/figure-unavailable',
      message: '图表未解析',
      retryable: false,
    }]);
    expect(result.content).toContain('## Page 1\n\nHello PDF');
    expect(result.content).toContain('## Page 2\n\n[No readable text on this page]');
    expect(readRangeMock).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      { startPage: 1, endPage: 10, signal: expect.any(AbortSignal) },
    );
  });

  it('PDF 分页不写入文件编辑缓存, 页码与文本行参数不能混用', async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'doc.pdf'), '%PDF-1.4\n%fake-content');
    const context = narrowContext(dir);
    readRangeMock.mockResolvedValue({ blocks: [], pageCount: 1, failures: [] });
    await FileReadTool.execute({ file_path: 'doc.pdf', start_page: 1, page_count: 1 }, context, invocation());
    expect(context.fileStateCache.get(path.join(dir, 'doc.pdf'))).toBeUndefined();
    await expect(FileReadTool.execute({ file_path: 'doc.pdf', offset: 1 }, context, invocation()))
      .rejects.toThrow('offset/limit do not apply to PDF');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    await expect(FileReadTool.execute({ file_path: 'notes.txt', start_page: 1 }, context, invocation()))
      .rejects.toThrow('start_page/page_count only apply to PDF');
  });

  it('拒绝超过体积上限的 PDF', async () => {
    const dir = makeDir();
    const filePath = path.join(dir, 'big.pdf');
    fs.writeFileSync(filePath, '%PDF-1.4');
    fs.truncateSync(filePath, 51 * 1024 * 1024);

    await expect(
      FileReadTool.execute(
        FileReadTool.inputSchema.parse({ file_path: 'big.pdf' }),
        narrowContext(dir),
        invocation(),
      ),
    ).rejects.toThrow(/too large/);
  });

  it('拒绝没有 PDF 签名的文件', async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'fake.pdf'), 'not-a-pdf');

    await expect(
      FileReadTool.execute(
        FileReadTool.inputSchema.parse({ file_path: 'fake.pdf' }),
        narrowContext(dir),
        invocation(),
      ),
    ).rejects.toThrow(/valid PDF signature/);
  });
});

describe('FileReadTool 模型投影与摘要', () => {
  it('无 warnings 时原样返回正文', () => {
    const content = String(FileReadTool.mapResultToModelContent!({
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
    const content = String(FileReadTool.mapResultToModelContent!({
      type: 'pdf_content',
      filePath: 'a.pdf',
      content: '## Page 1\n\nHello',
      startPage: 1,
      endPage: 1,
      totalPages: 1,
      warnings: [{
        page: 3,
        code: 'pdf/figure-unavailable',
        message: '图表未解析',
        retryable: false,
      }],
    }));
    expect(content).toContain('[读取不完整]');
    expect(content).toContain('第 3 页: 图表未解析');
  });

});

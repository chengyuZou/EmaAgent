import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStateCache, type ToolInvocation } from '@ema-agent/tools';
import { FileReadTool } from '../tools/FileReadTool/FileReadTool.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function pdfFixture(texts: readonly string[]): string {
  const pageIds = texts.map((_, index) => 4 + index * 2);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${texts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, text] of texts.entries()) {
    const content = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index]! + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  return pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
}

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-read-pdf-'));
  temporaryDirectories.push(directory);
  const controller = new AbortController();
  const invocation: ToolInvocation = {
    sessionId: 'pdf-session',
    turnId: 'pdf-turn',
    toolCallId: 'pdf-call',
    signal: controller.signal,
  };
  const context = { cwd: directory, fileStateCache: new FileStateCache() };
  const texts = [
    'First page has enough readable text for the digital PDF parser.',
    'second page continues without merging into the previous page.',
    'Third page contains more readable text for the pagination test.',
  ];
  fs.writeFileSync(path.join(directory, 'document.pdf'), pdfFixture(texts));
  return { context, invocation, controller, texts };
}

describe('Read 的真实 PDF 解析', () => {
  it('真实 pdfjs 只返回请求页, 保留总页数和续读位置', async () => {
    const { context, invocation, texts } = setup();
    const result = await FileReadTool.execute({
      file_path: 'document.pdf', start_page: 2, page_count: 1,
    }, context, invocation);
    expect(result.type).toBe('pdf_content');
    if (result.type !== 'pdf_content') throw new Error('Expected PDF content');
    expect(result).toMatchObject({ startPage: 2, endPage: 2, totalPages: 3, nextPage: 3, warnings: [] });
    expect(result.content).toContain(texts[1]);
    expect(result.content).not.toContain(texts[0]);
    expect(String(FileReadTool.mapResultToModelContent!(result))).toContain('start_page=3');
    expect(context.fileStateCache.get(path.join(context.cwd, 'document.pdf'))).toBeUndefined();
  });

  it('分页原文保持正确的页码归属, 不把下一页续段归到上一页', async () => {
    const { context, invocation, texts } = setup();
    const result = await FileReadTool.execute({
      file_path: 'document.pdf', page_count: 2,
    }, context, invocation);
    if (result.type !== 'pdf_content') throw new Error('Expected PDF content');
    const secondPage = result.content.split('## Page 2')[1];
    expect(secondPage).toContain(texts[1]);
    expect(result.content.split('## Page 2')[0]).toContain(texts[0]);
    expect(result.content.split('## Page 2')[0]).not.toContain(texts[1]);
  });

  it('取消和越界页码都不会写入编辑缓存', async () => {
    const { context, invocation, controller } = setup();
    await expect(FileReadTool.execute({
      file_path: 'document.pdf', start_page: 9,
    }, context, invocation)).rejects.toThrow(RangeError);
    controller.abort();
    await expect(FileReadTool.execute({
      file_path: 'document.pdf',
    }, context, invocation)).rejects.toThrow();
    expect(context.fileStateCache.get(path.join(context.cwd, 'document.pdf'))).toBeUndefined();
  });
});

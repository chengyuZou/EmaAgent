import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileStateCache } from '@ema-agent/tools';
import type { ToolPermissionContext } from '@ema-agent/permission';
import { WebFetchTool } from '../tools/WebFetchTool/WebFetchTool.js';
import { FileReadTool } from '../tools/FileReadTool/FileReadTool.js';
import { clearWebFetchCache } from '../tools/WebFetchTool/storage/cache.js';
import { closeWebRequests } from '../tools/WebFetchTool/network/webRequests.js';
import { configureWebDownloads } from '../tools/WebFetchTool/storage/webDownloads.js';

let directory: string;
let downloadsDir: string;
const invocation = {
  sessionId: 'download-session', turnId: 'download-turn', toolCallId: 'download-call',
  signal: new AbortController().signal,
};

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-web-download-'));
  downloadsDir = path.join(directory, 'data', 'web-fetch');
  configureWebDownloads(path.join(directory, 'data'));
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'EMA_WEB_SYSTEM_PROXY']) {
    vi.stubEnv(name, '');
    vi.stubEnv(name.toLowerCase(), '');
  }
  clearWebFetchCache();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await closeWebRequests();
  vi.unstubAllEnvs();
  clearWebFetchCache();
  await fs.rm(directory, { recursive: true, force: true });
});

function mockResponse(body: Uint8Array | string, contentType: string) {
  const mock = vi.fn(async () => {
    const response = new Response(body, {
      headers: {
        'content-type': contentType,
        'content-disposition': 'attachment; filename="../../outside.pdf"',
      },
    });
    Object.defineProperty(response, 'url', { value: 'https://example.test/final' });
    return response;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function fetchFile(url = 'https://example.test/download', raw = false) {
  const context = WebFetchTool.validateContext({
    cwd: directory, platform: process.platform,
  });
  if (!context.valid) throw new Error('Expected the WebFetch context');
  return WebFetchTool.execute(
    WebFetchTool.inputSchema.parse({ url, raw, max_length: 1, start_index: 100 }),
    context.context,
    invocation,
  );
}

function textPdf(): Buffer {
  const stream = 'BT /F1 12 Tf 72 720 Td (Downloaded PDF text with a complete readable paragraph.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe('WebFetch downloads', () => {
  it.each(['application/pdf', 'application/octet-stream'])('saves %s unchanged and Read parses the PDF', async contentType => {
    const pdf = textPdf();
    const mock = mockResponse(pdf, contentType);
    const result = await fetchFile();
    expect(result.download).toMatchObject({ contentType: 'application/pdf' });
    const filePath = result.download!.filePath;
    expect(path.dirname(filePath)).toBe(downloadsDir);
    expect(path.extname(filePath)).toBe('.pdf');
    expect(await fs.readFile(filePath)).toEqual(pdf);
    expect(result.bytes).toBe(pdf.length);
    expect(result.truncated).toBe(false);
    expect(result.content).toContain(filePath);
    expect(result.content).not.toContain('%PDF');
    expect(WebFetchTool.mapResultToModelContent!(result)).toContain(filePath);

    const readContext = FileReadTool.validateContext({
      cwd: directory, platform: process.platform, fileStateCache: new FileStateCache(),
    });
    if (!readContext.valid) throw new Error('Expected the Read context');
    const permissions: ToolPermissionContext = {
      mode: 'default', workspaceRoots: [], alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {},
    };
    expect((await FileReadTool.checkPermissions({ file_path: filePath }, readContext.context, permissions)).behavior).toBe('allow');
    const read = await FileReadTool.execute({ file_path: filePath }, readContext.context, invocation);
    expect(read.type).toBe('pdf_content');
    expect(read.content).toContain('Downloaded PDF text');

    expect((await fetchFile(undefined, true)).download?.filePath).toBe(filePath);
    expect(mock).toHaveBeenCalledTimes(1);
    permissions.alwaysDenyRules.userSettings = ['Read(**)'];
    expect((await FileReadTool.checkPermissions({ file_path: filePath }, readContext.context, permissions)).behavior).toBe('deny');
    permissions.alwaysDenyRules = {};
    permissions.alwaysAskRules.userSettings = ['Read(**)'];
    expect((await FileReadTool.checkPermissions({ file_path: filePath }, readContext.context, permissions)).behavior).toBe('ask');
    permissions.alwaysAskRules = {};
    expect((await FileReadTool.checkPermissions({ file_path: path.join(directory, 'data', 'private.txt') }, readContext.context, permissions)).behavior).toBe('ask');
  });

  it.each([
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
    ['application/x-unknown', '.bin'],
  ])('keeps %s binary rather than decoding XML-looking MIME names', async (contentType, extension) => {
    const bytes = new Uint8Array([0x50, 0x4b, 0, 0xff]);
    mockResponse(bytes, contentType);
    const result = await fetchFile();
    expect(path.extname(result.download!.filePath)).toBe(extension);
    expect(await fs.readFile(result.download!.filePath)).toEqual(Buffer.from(bytes));
    expect(result.content).not.toContain('\ufffd');
  });

  it('scopes cached paths to the download directory and replaces a manually removed file', async () => {
    const mock = mockResponse(textPdf(), 'application/pdf');
    const first = await fetchFile();
    configureWebDownloads(path.join(directory, 'other-data'));
    const other = await fetchFile();
    expect(path.dirname(other.download!.filePath)).toBe(path.join(directory, 'other-data', 'web-fetch'));
    expect(other.download!.filePath).not.toBe(first.download!.filePath);
    configureWebDownloads(path.join(directory, 'data'));
    await fs.unlink(first.download!.filePath);
    const replaced = await fetchFile();
    expect(replaced.download!.filePath).not.toBe(first.download!.filePath);
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('does not overwrite concurrent downloads or keep files after the response exceeds its limit', async () => {
    mockResponse(textPdf(), 'application/pdf');
    const results = await Promise.all([fetchFile(), fetchFile()]);
    expect(new Set(results.map(result => result.download!.filePath)).size).toBe(2);
    const before = await fs.readdir(downloadsDir);
    mockResponse(new Uint8Array(10 * 1024 * 1024 + 1), 'application/pdf');
    await expect(fetchFile('https://example.test/large')).rejects.toThrow('上限');
    expect(await fs.readdir(downloadsDir)).toEqual(before);
  });

  it('does not save an interrupted response', async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      pull(stream) {
        stream.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
        controller.abort(new Error('Stopped download'));
      },
      cancel: cancelled,
    }), { headers: { 'content-type': 'application/pdf' } })));
    const context = WebFetchTool.validateContext({
      cwd: directory, platform: process.platform,
    });
    if (!context.valid) throw new Error('Expected the WebFetch context');
    await expect(WebFetchTool.execute(
      WebFetchTool.inputSchema.parse({ url: 'https://example.test/interrupted' }),
      context.context,
      { ...invocation, signal: controller.signal },
    )).rejects.toThrow('Stopped download');
    expect(await fs.readdir(downloadsDir).catch(() => [])).toEqual([]);
  });

  it('does not grant Read access through a link escaping the download directory', async () => {
    const outside = path.join(directory, 'private');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'notes.txt'), 'Private notes');
    await fs.mkdir(downloadsDir, { recursive: true });
    const link = path.join(downloadsDir, 'linked');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const context = FileReadTool.validateContext({
      cwd: directory,
      platform: process.platform,
      fileStateCache: new FileStateCache(),
    });
    if (!context.valid) throw new Error('Expected the Read context');
    const permissions: ToolPermissionContext = {
      mode: 'default', workspaceRoots: [], alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {},
    };
    const decision = await FileReadTool.checkPermissions(
      { file_path: path.join(link, 'notes.txt') }, context.context, permissions,
    );
    expect(decision.behavior).toBe('ask');
    await fs.unlink(link);
  });
});

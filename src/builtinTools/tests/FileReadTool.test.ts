// FileReadTool 收口测试: 流式分页与双上限、去重缓存、BOM/CRLF、offset 越界、
// 截断模型可见、内容级二进制探测、流式取消、图片分支(base64/上限/拒绝分页)、
// mapResultToModelContent 三形态投影。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import type { ReadFileState, ToolInvocation } from '@ema-agent/tools';
import { FileReadTool, type FileReadResult } from '../tools/FileReadTool/FileReadTool.js';

function makeCtx(workspaceRoot = ''): { readFileState: ReadFileState; workspaceRoot: string } {
  return { readFileState: new Map(), workspaceRoot };
}

function makeInvocation(signal?: AbortSignal): ToolInvocation {
  return {
    sessionId: asSessionId('00000000-0000-4000-8000-0000000000f1'),
    turnId: asTurnId('00000000-0000-4000-8000-0000000000f2'),
    toolCallId: asToolCallId('call-read-1'),
    signal: signal ?? new AbortController().signal,
  };
}

// 临时目录统一登记, 每个用例结束清理——大文件用例单次跑会在 %TEMP% 留几十 MB。
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-fileread-'));
  tempDirs.push(dir);
  return dir;
}

function writeLines(filePath: string, count: number, fill = 'x'): void {
  const line = `${fill.repeat(60)}\n`;
  fs.writeFileSync(filePath, line.repeat(count));
}

async function read(
  filePath: string,
  opts: { offset?: number; limit?: number; ctx?: ReturnType<typeof makeCtx>; signal?: AbortSignal } = {},
): Promise<{ result: FileReadResult; ctx: ReturnType<typeof makeCtx> }> {
  const ctx = opts.ctx ?? makeCtx();
  const input: { file_path: string; offset?: number; limit?: number } = { file_path: filePath };
  if (opts.offset !== undefined) input.offset = opts.offset;
  if (opts.limit !== undefined) input.limit = opts.limit;
  const result = await FileReadTool.execute(input, ctx, makeInvocation(opts.signal));
  return { result, ctx };
}

/** 收窄到文本分支; 非文本结果直接让断言失败。 */
function asText(result: FileReadResult): Extract<FileReadResult, { type: 'file_content' }> {
  if (result.type !== 'file_content') throw new Error(`expected file_content, got ${result.type}`);
  return result;
}

describe('FileReadTool — 快路径(小文件)', () => {
  it('整读返回全部行, 缓存存完整原文(供 Edit 精确比对)', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'l1\nl2\nl3\n');

    const { result, ctx } = await read(file);

    const text = asText(result);
    expect(text.totalLines).toBe(4); // 结尾 \n 产生末尾空行, 与 split 口径一致
    expect(text.content).toContain('l2');
    const entry = ctx.readFileState.get(path.resolve(file))!;
    expect(entry.isPartialView).toBe(false);
    expect(entry.content).toBe('l1\nl2\nl3\n'); // 完整原文
  });

  it('分页返回切片, 缓存只存切片不存全文', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'b.txt');
    fs.writeFileSync(file, 'a1\na2\na3\na4\na5\n');

    const { result, ctx } = await read(file, { offset: 2, limit: 2 });

    const text = asText(result);
    expect(text.totalLines).toBe(6);
    expect(text.content).toContain('a2');
    expect(text.content).toContain('a3');
    expect(text.content).not.toContain('a1');
    const entry = ctx.readFileState.get(path.resolve(file))!;
    expect(entry.isPartialView).toBe(true);
    expect(entry.content).toBe('a2\na3'); // 只有切片, 不是全文
    expect(entry.totalLines).toBe(6);
  });

  it('剥 BOM 且行尾 \\r 归一', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'c.txt');
    fs.writeFileSync(file, '﻿x1\r\nx2\r\n');

    const { result } = await read(file);

    const text = asText(result);
    expect(text.content).toContain('x1\n');
    expect(text.content).not.toContain('\r');
    expect(text.content).not.toContain('﻿');
  });
});

describe('FileReadTool — 流式路径(大文件)', () => {
  it('超过 10 MiB 整读拒绝, 分页走流式且缓存只有切片', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'big.log');
    writeLines(file, 200_000); // ≈12 MiB

    await expect(read(file)).rejects.toThrow('too large');

    const { result, ctx } = await read(file, { offset: 100_000, limit: 5 });
    const text = asText(result);
    expect(text.totalLines).toBe(200_001);
    expect(text.isPartialView).toBe(true);

    const entry = ctx.readFileState.get(path.resolve(file))!;
    // 关键回归: 修复前缓存整个 12MB raw, 现在只有 5 行切片
    expect(entry.content.length).toBeLessThan(1024);
    expect(entry.totalLines).toBe(200_001);
  }, 30_000);

  it('流式 totalLines 与 split 口径一致(文件以换行结尾)', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'big2.log');
    writeLines(file, 200_000);

    const { result } = await read(file, { offset: 200_000, limit: 10 });
    const text = asText(result);
    expect(text.totalLines).toBe(200_001);
    // 第 200000 行有内容, 第 200001 行(末尾空行)也在范围内
    expect(text.content).not.toBe('');
  }, 30_000);

  it('流式剥 BOM 与 \\r', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'big3.log');
    const line = `${'y'.repeat(60)}\r\n`;
    fs.writeFileSync(file, '﻿' + line.repeat(200_000));

    const { result } = await read(file, { offset: 1, limit: 3 });
    const text = asText(result);
    expect(text.content).not.toContain('\r');
    expect(text.content).not.toContain('﻿');
  }, 30_000);
});

describe('FileReadTool — 去重回放', () => {
  it('同文件同范围同 mtime 返回 file_unchanged', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'd.txt');
    fs.writeFileSync(file, 'q1\nq2\nq3\n');

    const ctx = makeCtx();
    await read(file, { offset: 1, limit: 2, ctx });
    const { result } = await read(file, { offset: 1, limit: 2, ctx });

    expect(result.type).toBe('file_unchanged');
  });

  it('mtime 变化后重新读取', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'e.txt');
    fs.writeFileSync(file, 'w1\n');

    const ctx = makeCtx();
    await read(file, { ctx });
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(file, 'w1-changed\n');

    const { result } = await read(file, { ctx });
    const text = asText(result);
    expect(text.content).toContain('w1-changed');
  });
});

describe('FileReadTool — 边界与防御', () => {
  it('limit 有最大值(2000)', () => {
    const ok = FileReadTool.inputSchema.safeParse({ file_path: 'x', limit: 2000 });
    const over = FileReadTool.inputSchema.safeParse({ file_path: 'x', limit: 2001 });
    expect(ok.success).toBe(true);
    expect(over.success).toBe(false);
  });

  it('offset 越过文件末尾显式报错', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'only\n');

    await expect(read(file, { offset: 99, limit: 1 })).rejects.toThrow('beyond the end');
  });

  it('二进制扩展名拒绝', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'app.exe');
    fs.writeFileSync(file, 'MZ');

    await expect(read(file)).rejects.toThrow('Binary');
  });
});

describe('FileReadTool — 截断模型可见与回放保留', () => {
  it('单行超 50KB 预算: 模型收到空内容但知道原因(truncated/notice/nextOffset)', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'giant-line.txt');
    fs.writeFileSync(file, 'y'.repeat(300 * 1024) + '\n');

    const { result } = await read(file, { offset: 1, limit: 10 });

    const text = asText(result);
    expect(text.truncated).toBe(true);
    expect(text.truncationReason).toBe('bytes');
    expect(text.nextOffset).toBe(1);
    expect(text.notice).toContain('50 KB');
  });

  it('多行跨 50KB 边界: 装得下的行保留, 越界即截断并给出续读点', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'boundary.txt');
    const line = 'x'.repeat(40 * 1024);
    fs.writeFileSync(file, `${line}\n${line}\n${line}\n`);

    const { result } = await read(file, { offset: 1, limit: 3 });

    const text = asText(result);
    expect(text.truncated).toBe(true);
    // 第一行 40KB 装得下, 第二行累计 80KB 超 50KB 预算
    expect(text.content).not.toBe('');
    expect(text.nextOffset).toBe(2);
  });

  it('截断的去重回放保留 truncated(不再伪装未截断)', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'giant2.txt');
    fs.writeFileSync(file, 'y'.repeat(300 * 1024) + '\n');

    const ctx = makeCtx();
    await read(file, { offset: 1, limit: 10, ctx });
    const { result } = await read(file, { offset: 1, limit: 10, ctx });

    expect(result.type).toBe('file_unchanged');
    expect(result.truncated).toBe(true);
  });
});

describe('FileReadTool — 内容级二进制探测', () => {
  it('二进制改名 .txt 也被前 8KB 的 NUL 识破', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'fake.txt');
    const buf = Buffer.alloc(4096);
    for (let i = 0; i < 4096; i += 8) buf[i] = 0;
    fs.writeFileSync(file, buf);

    await expect(read(file)).rejects.toThrow('binary');
  });

  it('中文文本不会被误判为二进制', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'zh.txt');
    fs.writeFileSync(file, '第一行中文内容\n第二行こんにちは\n');

    const { result } = await read(file);
    const text = asText(result);
    expect(text.content).toContain('中文');
  });
});

describe('FileReadTool — 流式取消', () => {
  it('读取大文件途中 abort, 流被取消并拒绝', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'cancel.log');
    writeLines(file, 300_000);

    const controller = new AbortController();
    const pending = read(file, { offset: 1, limit: 2000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  }, 30_000);
});

// ── 图片分支 ──────────────────────────────────────────────────────────────────

/** 最小合法 PNG(1x1 透明)。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('FileReadTool — 图片分支', () => {
  it('PNG 返回 image_content(base64 + mediaType + 原始字节数)', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'shot.png');
    fs.writeFileSync(file, TINY_PNG);

    const { result } = await read(file);

    if (result.type !== 'image_content') throw new Error(`expected image_content, got ${result.type}`);
    expect(result.mediaType).toBe('image/png');
    expect(Buffer.from(result.base64, 'base64').equals(TINY_PNG)).toBe(true);
    expect(result.originalBytes).toBe(TINY_PNG.length);
    // 图片不写 readFileState(Edit 只比对文本)
    expect(result.filePath).toBe(file);
  });

  it('图片超过 5 MiB 直接拒绝', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'huge.png');
    fs.writeFileSync(file, Buffer.alloc(5 * 1024 * 1024 + 1));

    await expect(read(file)).rejects.toThrow('too large');
  });

  it('图片带 offset/limit 显式报错', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'shot2.png');
    fs.writeFileSync(file, TINY_PNG);

    await expect(read(file, { offset: 1 })).rejects.toThrow('do not apply to image');
  });
});

// ── map 投影 ──────────────────────────────────────────────────────────────────

describe('FileReadTool.mapResultToModelContent', () => {
  it('文本: 正文 + notice 拼接', () => {
    const out = FileReadTool.mapResultToModelContent!({
      type: 'file_content',
      filePath: 'a.txt',
      content: '     1\thi',
      totalLines: 1,
      isPartialView: true,
      truncated: true,
      nextOffset: 2,
      notice: 'Output truncated at 50 KB.',
    });
    expect(out).toBe('     1\thi\nOutput truncated at 50 KB.');
  });

  it('去重回放: 引导模型引用早前内容', () => {
    const out = FileReadTool.mapResultToModelContent!({
      type: 'file_unchanged',
      filePath: 'a.txt',
      totalLines: 3,
      isPartialView: false,
    });
    expect(out).toContain('unchanged since last read');
  });

  it('图片: 文本说明 + image_data part', () => {
    const out = FileReadTool.mapResultToModelContent!({
      type: 'image_content',
      filePath: 'shot.png',
      mediaType: 'image/png',
      base64: 'QUJD',
      originalBytes: 3,
    });
    expect(Array.isArray(out)).toBe(true);
    const parts = out as Array<{ type: string }>;
    expect(parts[0]!.type).toBe('text');
    expect(parts[1]).toMatchObject({ type: 'image_data', mimeType: 'image/png', data: 'QUJD' });
  });
});

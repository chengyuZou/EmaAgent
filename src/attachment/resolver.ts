// 把附件异步解析成模型可见图片或受控文件路径，避免同步文件读取阻塞 Turn 主链。

import { open, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { TurnContentPart } from '@ema-agent/turn';
import type { Attachment, ResolvedPrompt } from './types.js';

/** 超过这个大小的图片不内联，对大多数 Provider 来说太大了。 */
const IMAGE_INLINE_LIMIT = 5 * 1024 * 1024; // 5 MB

/**
 * 把一批附件解析成 LLM 能直接用的形式。
 *
 * 小于内联上限的 image/* -> base64 MessageContentPart（imageParts）。
 * 其他所有附件 -> 格式化成文本行，追加到 prompt 末尾（promptLines）。
 *
 * 不抛错：读文件失败时降级成一行警告，不让整个解析挂掉。
 */
export async function resolveForPrompt(
  attachments: Attachment[],
): Promise<ResolvedPrompt> {
  const imageParts: TurnContentPart[] = [];
  const fileLines: string[] = [];

  for (const att of attachments) {
    if (att.mime.startsWith('image/')) {
      const part = await tryInlineImage(att);
      if (part) { imageParts.push(part); continue; }
      // 走到这里：图片太大或读不了 -> 当路径引用处理
    }
    fileLines.push(await formatFileLine(att));
  }

  const promptLines = fileLines.length === 0
    ? ''
    : '[Attached files - file paths listed below for reference]\n' + fileLines.join('\n');

  return { imageParts, promptLines };
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

async function tryInlineImage(
  att: Attachment,
): Promise<TurnContentPart | null> {
  try {
    const data = await readWithinLimit(att.localPath, IMAGE_INLINE_LIMIT);
    if (!data) return null;
    return {
      type: 'image_data',
      data: data.toString('base64'),
      mimeType: att.mime,
      name: att.name,
    };
  } catch {
    return null;
  }
}

/**
 * 从同一个文件句柄校验并读取，避免路径在 stat 与 read 之间被替换。
 * 循环最多累计 limit + 1 字节，即使文件读取期间继续增长也不会整文件进内存。
 */
async function readWithinLimit(
  filePath: string,
  limit: number,
): Promise<Buffer | null> {
  const handle = await open(filePath, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > limit) return null;

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return Buffer.concat(chunks, total);
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function formatFileLine(att: Attachment): Promise<string> {
  const size    = formatSize(att.size);
  const mtime   = new Date(att.mtime).toISOString().replace('T', ' ').slice(0, 19);
  const exists  = await isFile(att.localPath);
  const warning = !exists ? '  ⚠ file not found on disk' : '';
  const ext     = path.extname(att.name);
  const hint    = largeFileHint(att.size, ext);

  return `• ${att.name}  (${att.mime}, ${size}, modified ${mtime})  ${att.localPath}${hint}${warning}`;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function largeFileHint(size: number, ext: string): string {
  const MB = 1024 * 1024;
  if (size < 2 * MB) return '';
  if (['.pdf', '.docx', '.pptx', '.xlsx'].includes(ext.toLowerCase())) {
    return '\n  [Large document - consider using knowledge-base search for repeated access]';
  }
  return '';
}

function formatSize(bytes: number): string {
  if (bytes < 1024)            return `${bytes} B`;
  if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

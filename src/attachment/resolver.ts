// 这里把附件解析成 LLM 能直接用的形式：小图片转 base64 内联进消息，其他文件转成路径文本塞进 prompt。

import * as fs   from 'node:fs';
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
export function resolveForPrompt(attachments: Attachment[]): ResolvedPrompt {
  const imageParts: TurnContentPart[] = [];
  const fileLines:  string[]             = [];

  for (const att of attachments) {
    if (att.mime.startsWith('image/')) {
      const part = tryInlineImage(att);
      if (part) { imageParts.push(part); continue; }
      // 走到这里：图片太大或读不了 -> 当路径引用处理
    }
    fileLines.push(formatFileLine(att));
  }

  const promptLines = fileLines.length === 0
    ? ''
    : '[Attached files - file paths listed below for reference]\n' + fileLines.join('\n');

  return { imageParts, promptLines };
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function tryInlineImage(att: Attachment): TurnContentPart | null {
  // B-071:不信任客户端传入的 att.size(可伪造),用 fs.statSync 真实字节判断。
  // 否则声明 1KB、实际 2GB 的文件会绕过 inline 限制,readFileSync 把整个 2GB 读进内存。
  let realSize: number;
  try {
    realSize = fs.statSync(att.localPath).size;
  } catch {
    return null;   // 文件不存在/不可 stat -> 降级路径引用
  }
  if (realSize > IMAGE_INLINE_LIMIT) return null;

  try {
    const data = fs.readFileSync(att.localPath).toString('base64');
    return { type: 'image_data', data, mimeType: att.mime, name: att.name };
  } catch {
    return null;
  }
}

function formatFileLine(att: Attachment): string {
  const size    = formatSize(att.size);
  const mtime   = new Date(att.mtime).toISOString().replace('T', ' ').slice(0, 19);
  const exists  = fs.existsSync(att.localPath);
  const warning = !exists ? '  ⚠ file not found on disk' : '';
  const ext     = path.extname(att.name);
  const hint    = largeFileHint(att.size, ext);

  return `• ${att.name}  (${att.mime}, ${size}, modified ${mtime})  ${att.localPath}${hint}${warning}`;
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

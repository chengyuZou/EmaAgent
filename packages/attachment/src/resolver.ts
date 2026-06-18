import * as fs   from 'node:fs';
import * as path from 'node:path';
import type { MessageContentPart } from '@ema-agent/contracts';
import type { Attachment, ResolvedPrompt } from './types.js';

/** Images above this size are not inlined — too large for most provider limits. */
const IMAGE_INLINE_LIMIT = 5 * 1024 * 1024; // 5 MB

/**
 * Resolve a list of attachments into LLM-ready form.
 *
 * image/* below the inline limit → base64 MessageContentPart (imageParts).
 * Everything else → formatted text lines for prompt injection (promptLines).
 *
 * Never throws: file read errors produce a warning line instead of crashing.
 */
export function resolveForPrompt(attachments: Attachment[]): ResolvedPrompt {
  const imageParts: MessageContentPart[] = [];
  const fileLines:  string[]             = [];

  for (const att of attachments) {
    if (att.mime.startsWith('image/')) {
      const part = tryInlineImage(att);
      if (part) { imageParts.push(part); continue; }
      // Fall through: image too large or unreadable → treat as path reference
    }
    fileLines.push(formatFileLine(att));
  }

  const promptLines = fileLines.length === 0
    ? ''
    : '[Attached files — use tools to read their contents]\n' + fileLines.join('\n');

  return { imageParts, promptLines };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tryInlineImage(att: Attachment): MessageContentPart | null {
  if (att.size > IMAGE_INLINE_LIMIT) return null;

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
    return '\n  [Large document — consider using knowledge-base search for repeated access]';
  }
  return '';
}

function formatSize(bytes: number): string {
  if (bytes < 1024)            return `${bytes} B`;
  if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

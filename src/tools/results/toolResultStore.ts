// 工具执行完成后把超大正文异步外置，并生成进入模型上下文的短预览。
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ToolResultStoreError } from '../errors.js';

const RESULT_PREVIEW_BYTES = 2_000;
const PERSISTED_OPEN = '<persisted-output>';
const PERSISTED_CLOSE = '</persisted-output>';

export class ToolResultStore {
  /** @param toolResultsDir 绝对路径: {sessionsDir}/{sessionId}/tool-results. */
  constructor(private readonly toolResultsDir: string) {}

  /**
   * 空输出转成明确占位, 超过 Tool 自身预算的正文落盘并替换为短预览.
   * 落盘只是上下文优化, 磁盘失败时必须返回原文, 不能丢掉真实 Tool Result.
   */
  async normalize(
    toolName: string,
    content: string,
    maxResultBytes: number,
  ): Promise<string> {
    if (content.trim() === '') return `(${toolName} completed with no output)`;
    if (maxResultBytes === Number.POSITIVE_INFINITY) return content;
    validatePositiveBudget(maxResultBytes, 'maxResultBytes');

    const originalSize = Buffer.byteLength(content, 'utf8');
    if (originalSize <= maxResultBytes) return content;

    try {
      await mkdir(this.toolResultsDir, { recursive: true });
      const filePath = path.join(this.toolResultsDir, `${randomUUID()}.txt`);
      await writeFile(filePath, content, 'utf8');

      const { preview, hasMore } = generatePreview(content, RESULT_PREVIEW_BYTES);
      const sizeKb = (originalSize / 1024).toFixed(1);
      return (
        `${PERSISTED_OPEN}\n`
        + `Output too large (${sizeKb} KB). Full output saved to: ${filePath}\n\n`
        + `Preview (first ${RESULT_PREVIEW_BYTES} bytes):\n`
        + `${preview}${hasMore ? '\n...\n' : '\n'}`
        + PERSISTED_CLOSE
      );
    } catch {
      return content;
    }
  }
}

/** 按 UTF-8 字节安全截断, 并优先保留预算后半段之前的完整行. */
function generatePreview(
  content: string,
  maxBytes: number,
): { preview: string; hasMore: boolean } {
  validatePositiveBudget(maxBytes, 'maxBytes');

  if (Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return { preview: content, hasMore: false };
  }

  let usedBytes = 0;
  let truncated = '';
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (usedBytes + characterBytes > maxBytes) break;
    truncated += character;
    usedBytes += characterBytes;
  }

  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline >= 0) {
    const lineBoundary = truncated.slice(0, lastNewline);
    if (Buffer.byteLength(lineBoundary, 'utf8') > maxBytes * 0.5) {
      return { preview: lineBoundary, hasMore: true };
    }
  }
  return { preview: truncated, hasMore: true };
}

function validatePositiveBudget(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ToolResultStoreError(`${name} must be a positive safe integer, got ${value}`);
  }
}

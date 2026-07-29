// 工具执行完成后按单项与批次预算保存超大正文，并为模型和 Session 生成稳定预览。
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_AGGREGATE_RESULT_BYTES = 200 * 1024;
export const DEFAULT_RESULT_PREVIEW_BYTES = 2_000;

const PERSISTED_OPEN = '<persisted-output>';
const PERSISTED_CLOSE = '</persisted-output>';

export type NormalizeResult =
  | { kind: 'unchanged' }
  | { kind: 'placeholder'; blockContent: string }
  | {
      kind: 'offloaded';
      blockContent: string;
      filePath: string;
      originalSize: number;
    };

export interface AggregateResultCandidate {
  callId: string;
  toolName: string;
  content: string;
  maxResultBytes: number;
}

/** 批次预算处理后，以 Tool Call ID 映射最终应持久化的模型可见内容。 */
export type AggregateResultContents = ReadonlyMap<string, string>;

export class ToolResultStore {
  /** @param toolResultsDir 绝对路径：{sessionsDir}/{sessionId}/tool-results */
  constructor(
    private readonly toolResultsDir: string,
    private readonly aggregateMaxBytes = DEFAULT_AGGREGATE_RESULT_BYTES,
  ) {
    assertPositiveBudget(aggregateMaxBytes, 'aggregateMaxBytes');
  }

  /** 空输出转占位；超过工具预算的正文落盘并替换为稳定预览。 */
  normalize(
    callId: string,
    toolName: string,
    content: string,
    maxResultBytes: number,
    forceOffload = false,
  ): NormalizeResult {
    if (content.trim() === '') {
      return { kind: 'placeholder', blockContent: `(${toolName} completed with no output)` };
    }
    if (content.startsWith(PERSISTED_OPEN)) return { kind: 'unchanged' };
    if (maxResultBytes === Number.POSITIVE_INFINITY) return { kind: 'unchanged' };
    assertPositiveBudget(maxResultBytes, 'maxResultBytes');

    const originalSize = Buffer.byteLength(content, 'utf8');
    if (!forceOffload && originalSize <= maxResultBytes) return { kind: 'unchanged' };

    try {
      fs.mkdirSync(this.toolResultsDir, { recursive: true });
      const filePath = this.pathFor(callId);
      try {
        fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { kind: 'unchanged' };
        // 同一 Tool Call 重放可以复用既有文件；内容不同说明身份发生碰撞，
        // 此时必须保留原始结果，不能让预览指向另一份正文。
        if (!existingFileMatches(filePath, content)) return { kind: 'unchanged' };
      }

      const { preview, hasMore } = generatePreview(content, DEFAULT_RESULT_PREVIEW_BYTES);
      const sizeKb = (originalSize / 1024).toFixed(1);
      const blockContent =
        `${PERSISTED_OPEN}\n` +
        `Output too large (${sizeKb} KB). Full output saved to: ${filePath}\n\n` +
        `Preview (first ${DEFAULT_RESULT_PREVIEW_BYTES} bytes):\n` +
        `${preview}${hasMore ? '\n...\n' : '\n'}` +
        PERSISTED_CLOSE;

      return { kind: 'offloaded', blockContent, filePath, originalSize };
    } catch {
      // 结果外置是上下文优化，不得因磁盘故障丢掉工具真实输出。
      return { kind: 'unchanged' };
    }
  }

  /** 并行结果总量超限时，从最大可外置结果开始降到批次预算以内。 */
  enforceAggregateBudget(candidates: readonly AggregateResultCandidate[]): AggregateResultContents {
    const contents = new Map(candidates.map(candidate => [candidate.callId, candidate.content]));
    let totalBytes = candidates.reduce(
      (sum, candidate) => sum + Buffer.byteLength(candidate.content, 'utf8'),
      0,
    );
    if (totalBytes <= this.aggregateMaxBytes) return contents;

    const eligible = candidates
      .filter(candidate => (
        candidate.maxResultBytes !== Number.POSITIVE_INFINITY
        && !candidate.content.startsWith(PERSISTED_OPEN)
        && candidate.content.trim() !== ''
      ))
      .map(candidate => ({
        ...candidate,
        size: Buffer.byteLength(candidate.content, 'utf8'),
      }))
      .sort((left, right) => right.size - left.size || left.callId.localeCompare(right.callId));

    for (const candidate of eligible) {
      if (totalBytes <= this.aggregateMaxBytes) break;
      const normalized = this.normalize(
        candidate.callId,
        candidate.toolName,
        candidate.content,
        candidate.maxResultBytes,
        true,
      );
      if (normalized.kind === 'unchanged') continue;
      const replacement = normalized.blockContent;
      const replacementBytes = Buffer.byteLength(replacement, 'utf8');
      // 很短的正文可能比“预览 + 路径”还小；这种替换无法降低聚合总量。
      if (replacementBytes >= candidate.size) continue;
      contents.set(candidate.callId, replacement);
      totalBytes += replacementBytes - candidate.size;
    }

    return contents;
  }

  read(callId: string): string | null {
    try {
      return fs.readFileSync(this.pathFor(callId), 'utf8');
    } catch {
      return null;
    }
  }

  private pathFor(callId: string): string {
    const safeName = createHash('sha256').update(callId).digest('hex').slice(0, 32);
    return path.join(this.toolResultsDir, safeName);
  }
}

/** 按 UTF-8 字节安全截断，并优先保留预算后半段之前的完整行。 */
export function generatePreview(
  content: string,
  maxBytes: number,
): { preview: string; hasMore: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative safe integer, got ${maxBytes}`);
  }
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

function assertPositiveBudget(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer, got ${value}`);
  }
}

function existingFileMatches(filePath: string, content: string): boolean {
  try {
    return fs.readFileSync(filePath, 'utf8') === content;
  } catch {
    return false;
  }
}

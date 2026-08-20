// 读取一条 Memory 轨道的摘要并裁剪到本轮注入预算.

import { promises as fs } from 'node:fs';
import { estimateTextTokens } from '@ema-agent/token';

const TRUNCATION_MARKER =
  '\n\n<!-- [记忆摘要已截断, 请按需查询正式 Memory 文件] -->\n';

export async function readMemorySummary(
  summaryFile: string,
  maxTokens: number,
): Promise<string | undefined> {
  const raw = await readTextFile(summaryFile);
  if (raw === undefined) {
    return undefined;
  }

  const summary = raw.trim();
  if (summary.length === 0) {
    return undefined;
  }
  return truncateMemorySummary(summary, maxTokens);
}

export function truncateMemorySummary(
  summary: string,
  maxTokens: number,
): string {
  if (estimateTextTokens(summary) <= maxTokens) {
    return summary;
  }

  const contentBudget = maxTokens - estimateTextTokens(TRUNCATION_MARKER);
  if (contentBudget <= 0) {
    return TRUNCATION_MARKER.trim();
  }

  let low = 0;
  let high = summary.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokens(summary.slice(0, middle)) <= contentBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  let end = low;
  if (end > 0 && isHighSurrogate(summary.charCodeAt(end - 1))) {
    end -= 1;
  }
  const lastNewline = summary.lastIndexOf('\n', end);
  if (lastNewline > 0 && end - lastNewline <= 200) {
    end = lastNewline;
  }
  return summary.slice(0, end).trimEnd() + TRUNCATION_MARKER;
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

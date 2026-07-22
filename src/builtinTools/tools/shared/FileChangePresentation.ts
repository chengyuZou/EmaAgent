// 这里负责把文件工具已经落盘的真实前后内容转换成有界的界面 diff。
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { FileChangePresentation } from '@ema-agent/contracts';

const MAX_DIFF_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_OUTPUT_CHARS = 200_000;

export function buildFileChangePresentation(
  filePath: string,
  previousContent: string | null,
  nextContent: string,
): FileChangePresentation {
  const operation = previousContent === null ? 'create' : 'update';
  const before = previousContent ?? '';
  const inputBytes = Buffer.byteLength(before, 'utf8') + Buffer.byteLength(nextContent, 'utf8');

  if (inputBytes > MAX_DIFF_INPUT_BYTES) {
    return {
      kind: 'file_change',
      operation,
      filePath,
      unifiedDiff: '',
      additions: operation === 'create' ? countLines(nextContent) : 0,
      deletions: 0,
      truncated: true,
      omittedReason: `文件前后内容合计超过 ${formatBytes(MAX_DIFF_INPUT_BYTES)}，未在界面计算完整 diff。`,
    };
  }

  const label = path.basename(filePath) || filePath;
  const completeDiff = createTwoFilesPatch(
    `a/${label}`,
    `b/${label}`,
    before,
    nextContent,
    '',
    '',
    { context: 3 },
  );
  const { additions, deletions } = countChanges(completeDiff);
  const truncated = completeDiff.length > MAX_DIFF_OUTPUT_CHARS;

  return {
    kind: 'file_change',
    operation,
    filePath,
    unifiedDiff: truncated
      ? `${completeDiff.slice(0, MAX_DIFF_OUTPUT_CHARS)}\n@@ diff 已截断 @@\n`
      : completeDiff,
    additions,
    deletions,
    truncated,
    ...(truncated ? { omittedReason: 'diff 展示超过 200,000 个字符，已截断。' } : {}),
  };
}

function countChanges(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MiB`;
}

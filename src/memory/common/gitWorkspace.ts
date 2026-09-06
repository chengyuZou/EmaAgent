// 管理一条 Memory 轨道的 Git 基线和整合输入文件.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  diffSinceBaseline,
  ensureBaseline,
  resetBaseline,
  type BaselineChangeStatus,
  type BaselineDiff,
} from '@ema-agent/git';

const MEMORY_DIFF_FILE_NAME = 'memory_workspace_diff.md';
const GIT_INDEX_LOCK_FILE = path.join('.git', 'index.lock');

export function memoryGitDiffFile(memoryDirectory: string): string {
  return path.join(memoryDirectory, MEMORY_DIFF_FILE_NAME);
}

export async function prepareMemoryGitWorkspace(
  memoryDirectory: string,
): Promise<void> {
  await fs.mkdir(memoryDirectory, { recursive: true });
  await removeMemoryGitDiff(memoryDirectory);
  // 同轨文件任务已经互斥；这里的 lock 只能来自上次进程中断，需在下一次 Git 写入前清掉。
  await fs.rm(path.join(memoryDirectory, GIT_INDEX_LOCK_FILE), { force: true });
  await ensureBaseline(memoryDirectory);
}

export async function readMemoryGitDiff(
  memoryDirectory: string,
  maxUnifiedDiffBytes: number,
): Promise<BaselineDiff> {
  await removeMemoryGitDiff(memoryDirectory);
  return diffSinceBaseline(memoryDirectory, { maxDiffBytes: maxUnifiedDiffBytes });
}

export async function writeMemoryGitDiff(
  memoryDirectory: string,
  diff: BaselineDiff,
  maxUnifiedDiffBytes: number,
): Promise<string> {
  const file = memoryGitDiffFile(memoryDirectory);
  await fs.writeFile(
    file,
    renderMemoryGitDiff(diff, maxUnifiedDiffBytes),
    'utf8',
  );
  return file;
}

export async function acceptMemoryGitChanges(
  memoryDirectory: string,
): Promise<void> {
  await removeMemoryGitDiff(memoryDirectory);
  await resetBaseline(memoryDirectory);
}

export async function removeMemoryGitDiff(
  memoryDirectory: string,
): Promise<void> {
  await fs.rm(memoryGitDiffFile(memoryDirectory), { force: true });
}

export function renderMemoryGitDiff(
  diff: BaselineDiff,
  maxUnifiedDiffBytes: number,
): string {
  let text = [
    '# Memory Workspace Diff',
    '',
    'Generated before memory consolidation. Read this file first and do not edit it.',
    '',
    '## Status',
  ].join('\n');

  if (diff.changes.length === 0) {
    return `${text}\n- none\n`;
  }

  for (const change of diff.changes) {
    text += `\n- ${changeStatusLabel(change.status)} ${change.path}`;
  }

  const unifiedDiff = truncateUtf8(diff.unifiedDiff, maxUnifiedDiffBytes);
  text += '\n\n## Diff\n\n```diff\n';
  text += unifiedDiff;
  if (!unifiedDiff.endsWith('\n')) {
    text += '\n';
  }
  if (Buffer.byteLength(diff.unifiedDiff, 'utf8') > maxUnifiedDiffBytes) {
    text += `\n[workspace diff truncated at ${maxUnifiedDiffBytes} bytes]\n`;
  }
  text += '```\n';
  return text;
}

function changeStatusLabel(status: BaselineChangeStatus): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  let result = Buffer.from(text, 'utf8')
    .subarray(0, maxBytes)
    .toString('utf8');
  while (result.endsWith('\uFFFD')) {
    result = result.slice(0, -1);
  }
  return result;
}

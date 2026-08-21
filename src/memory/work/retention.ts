// 找出 Work 轨中允许按墙钟清理的历史文件。

import { promises as fs } from 'node:fs';
import path from 'node:path';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

interface DatedWorkHistoryFile {
  readonly relativePath: string;
  readonly modifiedAtMs: number;
}

/** 返回超过保留天数的 Work history，按最久未修改优先。 */
export async function listExpiredWorkHistoryFiles(
  memoryRoot: string,
  retentionDays: number,
  nowMs: number = Date.now(),
): Promise<readonly string[]> {
  const expiresBeforeMs = nowMs - retentionDays * MILLISECONDS_PER_DAY;
  const files = await listWorkHistory(memoryRoot);
  return files
    .filter((file) => file.modifiedAtMs < expiresBeforeMs)
    .map((file) => file.relativePath);
}

/** 返回全部 Work history，供物理空间达到硬上限时继续按最旧优先清理。 */
export async function listWorkHistoryFilesOldestFirst(
  memoryRoot: string,
): Promise<readonly string[]> {
  return (await listWorkHistory(memoryRoot)).map((file) => file.relativePath);
}

async function listWorkHistory(
  memoryRoot: string,
): Promise<readonly DatedWorkHistoryFile[]> {
  const historyDirectory = path.join(memoryRoot, 'work', 'history');
  let entries;
  try {
    entries = await fs.readdir(historyDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }

  const files: DatedWorkHistoryFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
    const absolutePath = path.join(historyDirectory, entry.name);
    try {
      const stat = await fs.stat(absolutePath);
      files.push({
        relativePath: toPosix(path.relative(memoryRoot, absolutePath)),
        modifiedAtMs: stat.mtimeMs,
      });
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
  }

  return files.sort((left, right) => (
    left.modifiedAtMs - right.modifiedAtMs
    || left.relativePath.localeCompare(right.relativePath)
  ));
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

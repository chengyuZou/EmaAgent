import { promises as fs } from 'node:fs';
import path from 'node:path';
import { compactBaselineStorage } from '@ema-agent/git';
import { MEMORY_RELATIONSHIP_HISTORY_ACTIVE_DAYS } from './limits.js';
import {
  acceptMemoryGitChanges,
  removeMemoryGitDiff,
} from '../common/gitWorkspace.js';
import { listExpiredRelationshipHistoryFiles } from '../relationship/lifecycle.js';

export async function maintainWorkMemory(memoryDirectory: string): Promise<void> {
  if (!await isDirectory(memoryDirectory)) return;
  await removeMemoryGitDiff(memoryDirectory);
  await compactBaselineStorage(memoryDirectory);
}

export async function maintainRelationshipMemory(
  memoryRoot: string,
  memoryDirectory: string,
): Promise<void> {
  if (!await isDirectory(memoryDirectory)) return;
  await removeMemoryGitDiff(memoryDirectory);
  const expired = await listExpiredRelationshipHistoryFiles(
    memoryRoot,
    MEMORY_RELATIONSHIP_HISTORY_ACTIVE_DAYS,
  );
  for (const relativePath of expired) {
    await fs.rm(path.join(memoryRoot, relativePath), { force: true });
  }
  if (expired.length > 0) await acceptMemoryGitChanges(memoryDirectory);
  await compactBaselineStorage(memoryDirectory);
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

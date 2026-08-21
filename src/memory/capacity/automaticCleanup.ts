// 在 Memory 达到物理硬上限时，按两轨生命周期删除可清理文件。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { compactBaselineStorage } from '@ema-agent/git';
import { acceptMemoryGitChanges } from '../common/gitWorkspace.js';
import { MemoryStorageLimitExceededError } from '../errors.js';
import {
  listExpiredRelationshipHistoryFiles,
  listRelationshipHistoryFilesOldestFirst,
} from '../relationship/lifecycle.js';
import {
  listExpiredWorkHistoryFiles,
  listWorkHistoryFilesOldestFirst,
} from '../work/retention.js';
import { measureMemoryStorageBytes } from './measureStorageBytes.js';
import type { MemoryLifecycleSettings } from '../settings.js';
import type { MemoryStorageLimit } from './storageLimit.js';

interface CleanupFile {
  readonly relativePath: string;
  readonly bytes: number;
}

/**
 * 只在达到 maxBytes 后执行，并尽量清到 warningAtBytes 以下。
 * 核心正式记忆、用户未整合 notes 和无法识别日期的历史文件不进入候选。
 */
export async function cleanupMemoryStorage(
  memoryRoot: string,
  limit: MemoryStorageLimit,
  lifecycle: MemoryLifecycleSettings,
  signal: AbortSignal,
  lockFiles: (relativePaths: readonly string[]) => Promise<void>,
): Promise<void> {
  let usedBytes = await measureMemoryStorageBytes(memoryRoot);
  if (usedBytes < limit.maxBytes) return;

  // 物理统计包含 .git。先回收以往 amend 留下的旧对象，避免为了 Git 垃圾误删记忆。
  await compactTrackIfPresent(path.join(memoryRoot, 'work'));
  await compactTrackIfPresent(path.join(memoryRoot, 'relationship'));
  usedBytes = await measureMemoryStorageBytes(memoryRoot);
  if (usedBytes < limit.maxBytes) return;
  if (signal.aborted) throw signal.reason;

  const candidates = await listCleanupCandidates(memoryRoot, lifecycle);
  let nextCandidate = 0;
  while (usedBytes > limit.warningAtBytes) {
    if (signal.aborted) throw signal.reason;
    const selected: CleanupFile[] = [];
    let expectedBytes = usedBytes;
    while (nextCandidate < candidates.length && expectedBytes > limit.warningAtBytes) {
      const relativePath = candidates[nextCandidate++];
      if (relativePath === undefined) break;
      const bytes = await fileBytes(path.join(memoryRoot, relativePath));
      if (bytes === undefined) continue;
      selected.push({ relativePath, bytes });
      expectedBytes -= bytes;
    }

    if (selected.length === 0) {
      if (usedBytes >= limit.maxBytes) {
        throw new MemoryStorageLimitExceededError(usedBytes, limit.maxBytes);
      }
      return;
    }

    await lockFiles(selected.map((file) => file.relativePath));
    if (signal.aborted) throw signal.reason;
    // 从第一条删除开始就完整收口本批文件与 Git 基线，避免留下“用户删除”的假 diff。
    for (const file of selected) {
      await fs.rm(path.join(memoryRoot, file.relativePath), { force: true });
    }
    await acceptAndCompactAffectedTracks(memoryRoot, selected);
    usedBytes = await measureMemoryStorageBytes(memoryRoot);
  }
}

async function listCleanupCandidates(
  memoryRoot: string,
  lifecycle: MemoryLifecycleSettings,
): Promise<readonly string[]> {
  const phases = [
    await listTurnEvidenceFilesOldestFirst(memoryRoot),
    await listExpiredWorkHistoryFiles(
      memoryRoot,
      lifecycle.workHistoryRetentionDays,
    ),
    await listExpiredRelationshipHistoryFiles(
      memoryRoot,
      lifecycle.relationshipHistoryActiveDays,
    ),
    await listWorkHistoryFilesOldestFirst(memoryRoot),
    await listRelationshipHistoryFilesOldestFirst(memoryRoot),
  ];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const phase of phases) {
    for (const relativePath of phase) {
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      candidates.push(relativePath);
    }
  }
  return candidates;
}

async function listTurnEvidenceFilesOldestFirst(
  memoryRoot: string,
): Promise<readonly string[]> {
  const roots = [
    path.join(memoryRoot, 'work', 'turn_evidence'),
    path.join(memoryRoot, 'relationship', 'turn_evidence'),
  ];
  const files: Array<{ relativePath: string; modifiedAtMs: number }> = [];
  for (const root of roots) {
    await collectFiles(memoryRoot, root, files);
  }
  files.sort((left, right) => (
    left.modifiedAtMs - right.modifiedAtMs
    || left.relativePath.localeCompare(right.relativePath)
  ));
  return files.map((file) => file.relativePath);
}

async function collectFiles(
  memoryRoot: string,
  directory: string,
  files: Array<{ relativePath: string; modifiedAtMs: number }>,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(memoryRoot, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
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
}

async function fileBytes(absolutePath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(absolutePath)).size;
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function compactTrackIfPresent(trackDirectory: string): Promise<void> {
  try {
    if (!(await fs.stat(trackDirectory)).isDirectory()) return;
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw error;
  }
  await compactBaselineStorage(trackDirectory);
}

async function acceptAndCompactAffectedTracks(
  memoryRoot: string,
  deleted: readonly CleanupFile[],
): Promise<void> {
  const tracks = new Set(deleted.map((file) => file.relativePath.split('/')[0]));
  for (const track of ['work', 'relationship'] as const) {
    if (!tracks.has(track)) continue;
    const directory = path.join(memoryRoot, track);
    await acceptMemoryGitChanges(directory);
    await compactBaselineStorage(directory);
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

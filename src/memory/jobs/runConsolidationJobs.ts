import type {
  MemoryConsolidationJobKind,
  MemoryRepo,
} from '@ema-agent/storage';
import {
  MEMORY_CONSOLIDATION_ITEMS,
  MEMORY_GIT_DIFF_BYTES,
} from '../capacity/limits.js';
import {
  acceptMemoryGitChanges,
  prepareMemoryGitWorkspace,
  readMemoryGitDiff,
  writeMemoryGitDiff,
} from '../common/gitWorkspace.js';
import {
  applyConsolidationEdits,
  type ConsolidationSource,
  type MemoryConsolidationResult,
} from '../consolidation/consolidation.js';

export type ConsolidationKind = MemoryConsolidationJobKind;

export type ConsolidateMemory = (input: {
  readonly memoryDirectory: string;
  readonly diffFile: string;
  readonly unintegrated: readonly ConsolidationSource[];
  readonly signal: AbortSignal;
}) => Promise<MemoryConsolidationResult>;

export async function runConsolidationJobs(
  jobs: MemoryRepo,
  kind: ConsolidationKind,
  memoryDirectory: string,
  consolidate: ConsolidateMemory,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  const job = jobs.claimNext(kind, Date.now());
  if (!job) return false;
  try {
    await prepareMemoryGitWorkspace(memoryDirectory);
    const unintegrated: readonly ConsolidationSource[] = kind === 'work_consolidation'
      ? jobs.listUnintegratedWork(MEMORY_CONSOLIDATION_ITEMS)
      : jobs.listUnintegratedRelationship(MEMORY_CONSOLIDATION_ITEMS);
    if (unintegrated.length === 0) {
      jobs.complete(job.id, Date.now());
      return true;
    }
    const diff = await readMemoryGitDiff(memoryDirectory, MEMORY_GIT_DIFF_BYTES);
    const diffFile = await writeMemoryGitDiff(
      memoryDirectory,
      diff,
      MEMORY_GIT_DIFF_BYTES,
    );
    const result = await consolidate({
      memoryDirectory,
      diffFile,
      unintegrated,
      signal,
    });
    if (signal.aborted) return true;
    await applyConsolidationEdits(memoryDirectory, result.edits, signal);
    await acceptMemoryGitChanges(memoryDirectory);
    jobs.completeConsolidation(job.id, result.consumedTurnIds, Date.now());
    return true;
  } catch (error) {
    if (!signal.aborted) jobs.fail(job.id, errorMessage(error), Date.now());
    return true;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 执行一条 Work 或 Relationship 整合 Job，并统一收口文件与 SQL 状态。

import type {
  MemoryExtractionResult,
  MemoryJobsRepo,
  NewMemoryJobPath,
} from '@ema-agent/storage';
import {
  acceptMemoryGitChanges,
  prepareMemoryGitWorkspace,
  readMemoryGitDiff,
  writeMemoryGitDiff,
} from '../common/gitWorkspace.js';
import { applyConsolidationEdits } from '../consolidation/consolidation.js';
import type { ConsolidationPlan } from '../consolidation/consolidation.js';
import { workMemoryDir, relationshipMemoryDir } from '../common/paths.js';
import {
  MEMORY_CONSOLIDATION_ITEMS,
  MEMORY_GIT_DIFF_BYTES,
} from '../capacity/limits.js';
import { DEFAULT_MEMORY_JOBS_SETTINGS } from '../settings.js';
import type { JobAdmin } from './jobAdmin.js';

/** 整合冷却的墙钟换算：小时 → 毫秒。 */
const HOUR_MILLISECONDS = 60 * 60 * 1000;

export type ConsolidationKind = 'work_consolidation' | 'relationship_consolidation';

export type ConsolidateMemory = (input: {
  readonly memoryDirectory: string;
  readonly diffFile: string;
  readonly unintegrated: readonly MemoryExtractionResult[];
  readonly signal: AbortSignal;
}) => Promise<ConsolidationPlan>;

export interface RunConsolidationJobDeps {
  readonly jobs: MemoryJobsRepo;
  readonly admin: JobAdmin;
  readonly memoryDirectoryFor?: (kind: ConsolidationKind) => string;
  /** 当前存在、整合期间不能由用户同时编辑的文件。 */
  readonly listTargetPaths: (memoryDirectory: string) => readonly string[];
  readonly consolidate: ConsolidateMemory;
  readonly heartbeatSeconds?: number;
  /** 整合冷却小时数(0 = 关闭);缺省 memory.jobs.consolidationCooldownHours。 */
  readonly cooldownHours?: number;
  readonly signal: AbortSignal;
}

export type ConsolidationRunResult =
  | { readonly claimed: false }
  | {
      readonly claimed: true;
      readonly outcome:
        | 'completed'
        | 'noChanges'
        | 'cancelled'
        | 'lostOwnership'
        | 'failed';
    };

export async function runConsolidationJobs(
  deps: RunConsolidationJobDeps,
  kind: ConsolidationKind,
): Promise<ConsolidationRunResult> {
  if (deps.signal.aborted) return { claimed: false };
  // 整合冷却：以该轨上次成功整合(completed)的 finished_at 为基准，冷却期内
  // 不认领 Job——Job 留在 pending，第一步(prepareGitWorkspace/LLM)都不走。
  // 基准只用本轨整合 kind，绝不用提取或其它 kind 的时间，否则会卡死整合。
  const cooldownHours =
    deps.cooldownHours ?? DEFAULT_MEMORY_JOBS_SETTINGS.consolidationCooldownHours;
  if (cooldownHours > 0) {
    const lastCompletedAt = deps.jobs.lastCompletedAt(kind);
    if (
      lastCompletedAt !== undefined
      && Date.now() - lastCompletedAt < cooldownHours * HOUR_MILLISECONDS
    ) {
      return { claimed: false };
    }
  }
  const job = deps.jobs.claimNext(kind, Date.now());
  if (!job) return { claimed: false };

  const controller = new AbortController();
  deps.admin.registerController(job.id, controller);
  const abortOnGlobal = (): void => controller.abort(new Error('Memory 整合已中止'));
  deps.signal.addEventListener('abort', abortOnGlobal, { once: true });
  if (deps.signal.aborted) abortOnGlobal();
  const stopHeartbeat = deps.admin.startHeartbeat(
    job.id,
    () => controller.abort(new Error('Memory 整合失去 Job 所有权')),
    deps.heartbeatSeconds,
  );

  try {
    if (controller.signal.aborted) return stoppedOutcome(deps.jobs, job.id);

    const memoryDirectory = (deps.memoryDirectoryFor ?? defaultMemoryDirectoryFor)(kind);
    await prepareMemoryGitWorkspace(memoryDirectory);
    if (controller.signal.aborted) return stoppedOutcome(deps.jobs, job.id);

    const unintegrated = deps.jobs.listUnintegratedExtractionResults(
      extractionKindFor(kind),
      MEMORY_CONSOLIDATION_ITEMS,
    );
    const diff = await readMemoryGitDiff(memoryDirectory, MEMORY_GIT_DIFF_BYTES);
    if (unintegrated.length === 0 && diff.changes.length === 0) {
      return deps.jobs.complete(job.id, Date.now())
        ? { claimed: true, outcome: 'noChanges' }
        : stoppedOutcome(deps.jobs, job.id);
    }

    if (!setRunningPaths(
      deps.jobs,
      job.id,
      deps.listTargetPaths(memoryDirectory).map((relativePath) => ({
        relativePath,
        operation: 'write_file',
      })),
    )) {
      return stoppedOutcome(deps.jobs, job.id);
    }
    const diffFile = await writeMemoryGitDiff(
      memoryDirectory,
      diff,
      MEMORY_GIT_DIFF_BYTES,
    );
    const plan = await deps.consolidate({
      memoryDirectory,
      diffFile,
      unintegrated,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return stoppedOutcome(deps.jobs, job.id);

    if (!setRunningPaths(
      deps.jobs,
      job.id,
      plan.edits.map((edit) => ({
        relativePath: edit.path,
        operation: edit.operation === 'delete' ? 'delete_file' : 'write_file',
      })),
    )) {
      return stoppedOutcome(deps.jobs, job.id);
    }
    await applyConsolidationEdits(memoryDirectory, plan.edits, controller.signal);
    if (controller.signal.aborted) return stoppedOutcome(deps.jobs, job.id);
    if (!deps.jobs.heartbeat(job.id, Date.now())) {
      return stoppedOutcome(deps.jobs, job.id);
    }

    await acceptMemoryGitChanges(memoryDirectory);
    const completed = deps.jobs.completeConsolidation(
      job.id,
      plan.extractionJobIds,
      Date.now(),
    );
    return completed
      ? { claimed: true, outcome: 'completed' }
      : stoppedOutcome(deps.jobs, job.id);
  } catch (error) {
    if (deps.jobs.findById(job.id)?.status === 'cancelled') {
      return { claimed: true, outcome: 'cancelled' };
    }
    if (deps.signal.aborted || controller.signal.aborted) {
      return { claimed: true, outcome: 'lostOwnership' };
    }
    deps.jobs.fail(job.id, errorMessage(error), Date.now());
    return { claimed: true, outcome: 'failed' };
  } finally {
    deps.signal.removeEventListener('abort', abortOnGlobal);
    stopHeartbeat();
    deps.admin.unregisterController(job.id);
  }
}

function setRunningPaths(
  jobs: MemoryJobsRepo,
  jobId: string,
  paths: readonly NewMemoryJobPath[],
): boolean {
  const unique = new Map(paths.map((entry) => [entry.relativePath, entry]));
  return jobs.setRunningPaths(jobId, [...unique.values()]);
}

function stoppedOutcome(
  jobs: MemoryJobsRepo,
  jobId: string,
): Extract<ConsolidationRunResult, { claimed: true }> {
  return {
    claimed: true,
    outcome: jobs.findById(jobId)?.status === 'cancelled'
      ? 'cancelled'
      : 'lostOwnership',
  };
}

function defaultMemoryDirectoryFor(kind: ConsolidationKind): string {
  return kind === 'work_consolidation' ? workMemoryDir() : relationshipMemoryDir();
}

function extractionKindFor(
  kind: ConsolidationKind,
): 'work_extraction' | 'relationship_extraction' {
  return kind === 'work_consolidation' ? 'work_extraction' : 'relationship_extraction';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 有界并发执行 Work 与 Relationship 两条提取队列，并把结果收口到 SQL。

import type {
  MemoryExtractionJobKind,
  MemoryJob,
  MemoryJobsRepo,
} from '@ema-agent/storage';
import { DEFAULT_MEMORY_JOBS_SETTINGS } from '../settings.js';
import type { JobAdmin } from './jobAdmin.js';

/** 提取轨的 claim 顺序:work 优先、relationship 次之(同 created_at 下稳定)。 */
const EXTRACTION_KINDS: readonly MemoryExtractionJobKind[] = [
  'work_extraction',
  'relationship_extraction',
];

export interface RunExtractionJobDeps {
  /** SQL Job 事实源。 */
  readonly jobs: MemoryJobsRepo;
  /** Job 生命周期管理面:注册/注销取消句柄。 */
  readonly admin: JobAdmin;
  /**
   * 对单个 Turn 执行一次提取,返回该轨待整合内容;undefined 表示无可记录内容
   * (no-op)。内部读 Turn 事实 → 轨道投影 → system+user 两段 LLM
   * → 空/NO_MEMORY 归一为 undefined。
   */
  readonly extractTurn: (input: {
    readonly kind: MemoryExtractionJobKind;
    readonly turnId: string;
    readonly signal: AbortSignal;
  }) => Promise<string | undefined>;
  /** 提取并发上限;缺省 DEFAULT_CONCURRENCY。 */
  readonly concurrency?: number;
  /** 全局停止信号(应用关闭);触发后不再 claim,在途 Job 保持 running 等启动恢复。 */
  readonly signal: AbortSignal;
}

/** 一次 drain 完成后的统计。 */
export interface ExtractionRunStats {
  readonly claimed: number;
  readonly succeededWithOutput: number;
  readonly succeededNoOutput: number;
  readonly failed: number;
}

/** 内部可变统计(对外只读)。 */
interface MutableExtractionRunStats {
  claimed: number;
  succeededWithOutput: number;
  succeededNoOutput: number;
  failed: number;
}

/**
 * 认领并执行当前所有 pending 提取 Job。
 *
 * 有界并发 drain:同步 claim(两条 kind 各取最早 pending),每个 Job 独立执行,
 * 完成/失败后补位;全局 signal abort 时停止认领并中止在途,不写终态
 * (running 遗留由下次启动 recoverInterrupted 收口)。
 */
export async function runExtractionJobs(
  deps: RunExtractionJobDeps,
): Promise<ExtractionRunStats> {
  const stats: MutableExtractionRunStats = {
    claimed: 0,
    succeededWithOutput: 0,
    succeededNoOutput: 0,
    failed: 0,
  };
  const concurrency = Math.max(
    1,
    Math.trunc(deps.concurrency ?? DEFAULT_MEMORY_JOBS_SETTINGS.extractionConcurrency),
  );
  const workers = Array.from({ length: concurrency }, async () => {
    while (!deps.signal.aborted) {
      const job = claimNext(deps.jobs);
      if (!job) return;
      stats.claimed += 1;
      await runExtractionJob(deps, job, stats);
    }
  });
  await Promise.all(workers);
  return stats;
}

/** 按 EXTRACTION_KINDS 顺序取最早 pending Job;全部无候选返回 undefined。 */
function claimNext(jobs: MemoryJobsRepo): MemoryJob | undefined {
  for (const kind of EXTRACTION_KINDS) {
    const job = jobs.claimNext(kind, Date.now());
    if (job) return job;
  }
  return undefined;
}

/** 执行单个提取 Job:注册取消句柄 → 提取 → 三分收口。 */
async function runExtractionJob(
  deps: RunExtractionJobDeps,
  job: MemoryJob,
  stats: MutableExtractionRunStats,
): Promise<void> {
  const controller = new AbortController();
  deps.admin.registerController(job.id, controller);
  const abortOnGlobal = (): void =>
    controller.abort(new Error('Memory 提取已中止'));
  deps.signal.addEventListener('abort', abortOnGlobal, { once: true });
  if (deps.signal.aborted) abortOnGlobal();

  try {
    const turnId = job.turnId;
    if (!turnId) {
      // 提取 Job 必须绑定 turn(CHECK 约束保证,此处防御)。
      if (deps.jobs.fail(job.id, 'extraction job without turnId', Date.now())) {
        stats.failed += 1;
      }
      return;
    }
    const kind = job.kind as MemoryExtractionJobKind;

    // 执行前:已被中止(全局关闭/用户取消/失去所有权)则不启动提取。
    if (controller.signal.aborted) {
      return;
    }

    const content = await deps.extractTurn({ kind, turnId, signal: controller.signal });

    // 执行后:中止则不收口(全局/失权保持 running 等启动恢复;取消由 SQL 状态表达)。
    if (controller.signal.aborted) {
      return;
    }

    if (content === undefined) {
      // 无可记录内容也是正常完成，但不写提取结果。
      if (deps.jobs.complete(job.id, Date.now())) {
        stats.succeededNoOutput += 1;
      } else {
        stats.failed += 1; // 失去所有权(已被取消/恢复),不计数成功。
      }
      return;
    }

    // 提取正文与 completed 终态同事务提交(repo.completeExtraction)。
    if (deps.jobs.completeExtraction(job.id, content, Date.now())) {
      stats.succeededWithOutput += 1;
    } else {
      stats.failed += 1;
    }
  } catch (error) {
    // 用户取消:SQL 已置 cancelled,Worker 不再 fail(终态 CAS 本也会失败)。
    if (deps.jobs.findById(job.id)?.status === 'cancelled') {
      return;
    }
    // 执行中被全局中止/失去所有权:不写终态,保持 running 等启动恢复收口。
    if (deps.signal.aborted || controller.signal.aborted) {
      return;
    }
    const message = errorMessage(error);
    if (deps.jobs.fail(job.id, message, Date.now())) {
      stats.failed += 1;
    }
  } finally {
    deps.signal.removeEventListener('abort', abortOnGlobal);
    deps.admin.unregisterController(job.id);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

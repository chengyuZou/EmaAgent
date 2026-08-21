// 执行清除记忆和存储清理 Job，并维护取消、文件占用与终态。

import type {
  MemoryJob,
  MemoryJobsRepo,
  MemoryJobPath,
} from '@ema-agent/storage';
import {
  clearAllMemory,
  clearMemoryDirectory,
  clearMemoryFiles,
} from '../common/clearMemory.js';
import type { JobAdmin } from './jobAdmin.js';

/** 维护 Job 的 kind。 */
export type MaintenanceKind = 'clear_memory' | 'storage_cleanup';

export interface RunMaintenanceJobDeps {
  /** SQL Job 事实源。 */
  readonly jobs: MemoryJobsRepo;
  /** Job 生命周期管理面:注册/注销取消句柄 + 心跳。 */
  readonly admin: JobAdmin;
  /**
   * clear_memory 的相对路径解析基准(记忆总根)。
   * 路径由前端登记(memory_job_paths,delete_file/delete_tree);paths 为空 = 清除全部。
   */
  readonly memoryRoot: string;
  /**
   * storage_cleanup:调两轨清理规则。没有真实实现时不得启动该 Job。
   */
  readonly cleanup: (
    signal: AbortSignal,
    lockFiles: (relativePaths: readonly string[]) => Promise<void>,
  ) => Promise<void>;
  /** 心跳间隔秒;缺省 memory.jobs.heartbeatSeconds。 */
  readonly heartbeatSeconds?: number;
  /** 全局停止信号(应用关闭);触发后中止执行,不写终态。 */
  readonly signal: AbortSignal;
}

export type MaintenanceRunResult =
  | { readonly claimed: false }
  | {
      readonly claimed: true;
      readonly succeeded: boolean;
      readonly cancelled: boolean;
      readonly lostOwnership: boolean;
    };

/**
 * 认领并执行一条维护 Job(kind 由调用方指定)。
 *
 * clear_memory 与 storage_cleanup 共享同一骨架:claim → 注册取消句柄 + 心跳
 * → 分派执行 → 验租约 → complete / fail。repo.claimNext 的 runningConflicts
 * 已保证维护 Job 不与同轨整合并发。
 */
export async function runMaintenanceJobs(
  deps: RunMaintenanceJobDeps,
  kind: MaintenanceKind,
): Promise<MaintenanceRunResult> {
  // 已收到全局中止:不认领新 Job(避免关闭前还去删文件)。
  if (deps.signal.aborted) {
    return { claimed: false };
  }
  const job = deps.jobs.claimNext(kind, Date.now());
  if (!job) {
    return { claimed: false };
  }
  // claim 与执行之间被全局中止(竞态):不执行、不写终态,
  // 保持 running 等下次启动 recoverInterrupted 收口。
  if (deps.signal.aborted) {
    return { claimed: true, succeeded: false, cancelled: false, lostOwnership: false };
  }

  const controller = new AbortController();
  deps.admin.registerController(job.id, controller);
  const abortOnGlobal = (): void => controller.abort(new Error('Memory 维护已中止'));
  deps.signal.addEventListener('abort', abortOnGlobal, { once: true });
  if (deps.signal.aborted) abortOnGlobal();
  const stopHeartbeat = deps.admin.startHeartbeat(
    job.id,
    () => controller.abort(new Error('Memory 维护失去 Job 所有权')),
    deps.heartbeatSeconds,
  );

  try {
    // 执行前:已被中止(全局关闭/用户取消/失去所有权)则不执行——
    // 尤其 clear 是删文件,关闭前不该开始删除。
    if (controller.signal.aborted) {
      if (deps.jobs.findById(job.id)?.status === 'cancelled') {
        return { claimed: true, succeeded: false, cancelled: true, lostOwnership: false };
      }
      // 全局中止/失权:不写终态,保持 running 等启动恢复收口。
      return { claimed: true, succeeded: false, cancelled: false, lostOwnership: false };
    }

    if (kind === 'clear_memory') {
      // clear 一旦开始就完整执行,不响应中途中止(避免留下半删状态);
      // 是否收口成功由最终 CAS 决定。
      await runClearMemory(deps, job);
    } else {
      // cleanup 是渐进清理,闭包内部可安全响应 signal 中止。
      await runStorageCleanup(deps, job.id, controller.signal);
    }

    // 完成后验租约:失去所有权(被取消/恢复)则不写终态。
    if (!deps.jobs.heartbeat(job.id, Date.now())) {
      return { claimed: true, succeeded: false, cancelled: false, lostOwnership: true };
    }
    if (!deps.jobs.complete(job.id, Date.now())) {
      return { claimed: true, succeeded: false, cancelled: false, lostOwnership: true };
    }
    return { claimed: true, succeeded: true, cancelled: false, lostOwnership: false };
  } catch (error) {
    if (deps.jobs.findById(job.id)?.status === 'cancelled') {
      // 用户取消:SQL 已置 cancelled,不再 fail。
      return { claimed: true, succeeded: false, cancelled: true, lostOwnership: false };
    }
    if (deps.signal.aborted || controller.signal.aborted) {
      // 执行中被全局中止/失权:不写终态,保持 running 等启动恢复收口。
      return { claimed: true, succeeded: false, cancelled: false, lostOwnership: true };
    }
    const message = errorMessage(error);
    deps.jobs.fail(job.id, message.length > 0 ? message : 'failed_memory_maintenance', Date.now());
    return { claimed: true, succeeded: false, cancelled: false, lostOwnership: false };
  } finally {
    deps.signal.removeEventListener('abort', abortOnGlobal);
    stopHeartbeat();
    deps.admin.unregisterController(job.id);
  }
}

/**
 * 执行清除:按登记路径分派到 common/clearMemory 三目标。
 * paths 为空 = 全部清除(记忆总根内容,保留根本身)。
 */
async function runClearMemory(
  deps: RunMaintenanceJobDeps,
  job: MemoryJob,
): Promise<void> {
  const targets = deps.jobs.listPaths(job.id);
  if (targets.length === 0) {
    await clearAllMemory(deps.memoryRoot);
    return;
  }
  await clearPaths(deps.memoryRoot, targets);
}

/** 按登记 operation 分派目录和文件清除。 */
async function clearPaths(
  memoryRoot: string,
  targets: readonly MemoryJobPath[],
): Promise<void> {
  const files: string[] = [];
  for (const target of targets) {
    if (target.operation === 'delete_tree') {
      await clearMemoryDirectory(memoryRoot, target.relativePath);
    } else if (target.operation === 'delete_file') {
      files.push(target.relativePath);
    } else {
      throw new Error(`clear_memory Job 不能包含 ${target.operation}: ${target.relativePath}`);
    }
  }
  if (files.length > 0) {
    await clearMemoryFiles(memoryRoot, files);
  }
}

/** 执行存储清理:调两轨生命周期与容量规则。 */
async function runStorageCleanup(
  deps: RunMaintenanceJobDeps,
  jobId: string,
  signal: AbortSignal,
): Promise<void> {
  await deps.cleanup(signal, async (relativePaths) => {
    const paths = relativePaths.map((relativePath) => ({
      relativePath,
      operation: 'delete_file' as const,
    }));
    if (!deps.jobs.setRunningPaths(jobId, paths)) {
      throw new Error('Memory 存储清理已失去 Job 所有权');
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

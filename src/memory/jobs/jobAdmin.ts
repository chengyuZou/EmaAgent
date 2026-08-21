// Job 生命周期管理面:入队、重试、取消、启动恢复与取消句柄注册。
import { randomUUID } from 'node:crypto';
import type {
  MemoryExtractionJobKind,
  MemoryJob,
  MemoryJobsRepo,
} from '@ema-agent/storage';
import { DEFAULT_MEMORY_JOBS_SETTINGS } from '../settings.js';
import type { MemoryJobEnqueueError } from '../errors.js';
import type { MemoryEventEmitter } from '../events.js';

/** 一次根 Turn 完成后的双提取入队结果。失败的轨为 null 并在 errors 中留痕。 */
export interface EnqueuedExtraction {
  readonly work: MemoryJob | null;
  readonly relationship: MemoryJob | null;
  /** 入队失败明细；每条轨独立报告。 */
  readonly errors: readonly MemoryJobEnqueueError[];
}

/**
 * Job 生命周期管理面。
 *
 * 同一实例同时被两类调用方使用:
 *   - 业务触发(Server/turn 完成回调):enqueueExtraction / retry / recoverInterrupted;
 *   - 执行器(run*):registerController / unregisterController 挂取消句柄,
 *     cancel 通过该表向运行中 Job 发 AbortSignal。
 */
export class JobAdmin {
  private readonly jobs: MemoryJobsRepo;
  private readonly emit: MemoryEventEmitter | undefined;

  private readonly controllers = new Map<string, AbortController>();

  constructor(jobs: MemoryJobsRepo, emit?: MemoryEventEmitter) {
    this.jobs = jobs;
    this.emit = emit;
  }

  /**
   * 根 Turn completed 后登记两条提取 Job(work + relationship)。
   *
   * 只携带 turnId,不携带角色目录名或消息副本——提取事实由 runExtractionJobs
   * 的应用层闭包在运行时读取已完成 Turn 事实，SQL 只保存引用。
   *
   * 顺序固定 work 先、relationship 后(同 created_at 下按 id 稳定排序)。
   */
  enqueueExtraction(turnId: string): EnqueuedExtraction {
    const createdAt = Date.now();
    const errors: MemoryJobEnqueueError[] = [];
    // 分别 try/catch:一条失败不影响另一条入队;
    const work = this.tryEnqueue('work_extraction', turnId, createdAt, errors);
    const relationship = this.tryEnqueue(
      'relationship_extraction',
      turnId,
      createdAt,
      errors,
    );
    return { work, relationship, errors };
  }

  private tryEnqueue(
    kind: MemoryExtractionJobKind,
    turnId: string,
    createdAt: number,
    errors: MemoryJobEnqueueError[],
  ): MemoryJob | null {
    try {
      return this.jobs.enqueue({
        id: randomUUID(),
        kind,
        turnId,
        createdAt,
      });
    } catch (error) {
      const message = errorMessage(error);
      errors.push({ kind, error: message });
      try {
        this.emit?.({
          type: 'memory_enqueue_failed',
          turnId,
          kind,
          error: message,
          at: Date.now(),
        });
      } catch {
        // 事件只用于通知；SQL 入队结果和 errors 才是本次调用的业务结果。
      }
      return null;
    }
  }

  // ── 重试 ───────────────────────────────────────────────────────────────────

  /**
   * 重试一条 failed Job:复制其业务身份(kind/turnId)与文件目标到一条新 pending Job。
   *
   * 只允许 failed 重试;原 Job 保留为失败记录(前端据此说明发生过什么)。
   * 返回 undefined 表示该 Job 不存在或不是 failed。
   */
  retry(failedId: string): MemoryJob | undefined {
    return this.jobs.retry(failedId, randomUUID(), Date.now());
  }

  // ── 取消 ───────────────────────────────────────────────────────────────────

  /**
   * 取消 Job:pending 直接置 cancelled;running 先改 SQL 再向运行句柄发
   * AbortSignal——Worker 的终态 CAS 会因状态已变而失败,不可反写 completed。
   *
   * 返回 false 表示 Job 不存在或已处于终态。
   */
  cancel(jobId: string): boolean {
    if (!this.jobs.cancel(jobId, Date.now())) {
      return false;
    }
    this.controllers.get(jobId)?.abort(new Error('Memory Job 已取消'));
    return true;
  }

  /**
   * 应用启动后调用:旧进程遗留的 running Job 标记为 failed(错误写明被中断),
   * 不自动重跑。返回被收口的行数。
   */
  recoverInterrupted(): number {
    return this.jobs.failInterruptedRunning(Date.now());
  }

  // ── 取消句柄注册 ───────────────────────────────────────────────────────────

  /**
   * 执行器开始运行 Job 时注册 AbortController;cancel 会 abort 它。
   * 同 id 重复注册时旧句柄被替换(理论上单写者不会发生)。
   */
  registerController(jobId: string, controller: AbortController): void {
    this.controllers.set(jobId, controller);
    if (this.jobs.findById(jobId)?.status !== 'running') {
      controller.abort(new Error('Memory Job 已失去运行权'));
    }
  }

  /** 执行器终态收口后注销;避免泄漏与误伤后续同名 Job。 */
  unregisterController(jobId: string): void {
    this.controllers.delete(jobId);
  }

  /**
   * 关闭/测试收尾:向全部在途 Job 发 AbortSignal。
   * 只发信号,不等待落定——等待在途任务由执行器的 shutdown 负责。
   */
  abortAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort(new Error('Memory Job 已中止'));
    }
  }

  // ── 心跳(整合/维护执行器共享) ──────────────────────────────────────────────

  /**
   * 执行器运行期间周期性刷新 heartbeat_at;失败(失去所有权:被取消或启动恢复
   * 收口)时调用 onLostOwnership(执行器据此 abort 业务闭包)。
   * 返回停止函数。间隔缺省取 memory.jobs.heartbeatSeconds。
   */
  startHeartbeat(
    jobId: string,
    onLostOwnership: () => void,
    intervalSeconds?: number,
  ): () => void {
    const intervalMs =
      Math.max(1, intervalSeconds ?? DEFAULT_MEMORY_JOBS_SETTINGS.heartbeatSeconds) * 1000;
    const timer = setInterval(() => {
      if (!this.jobs.heartbeat(jobId, Date.now())) {
        clearInterval(timer);
        onLostOwnership();
      }
    }, intervalMs);
    // 不阻止进程退出。
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

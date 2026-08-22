// 持久化文件式双轨 Memory 的后台任务、提取结果与文件占用关系。

import type { SqliteDb } from '../../database/database.js';

export type MemoryJobKind =
  | 'work_extraction'
  | 'relationship_extraction'
  | 'work_consolidation'
  | 'relationship_consolidation'
  | 'clear_memory'
  | 'storage_cleanup';

/** 提取 Job 的 kind 子集(work + relationship 两轨);入队/事件/错误接口统一用它。 */
export type MemoryExtractionJobKind = Extract<
  MemoryJobKind,
  'work_extraction' | 'relationship_extraction'
>;

export type MemoryJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type MemoryJobPathOperation =
  | 'write_file'
  | 'delete_file'
  | 'delete_tree';

export interface MemoryJob {
  readonly id: string;
  readonly kind: MemoryJobKind;
  readonly status: MemoryJobStatus;
  readonly turnId: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly heartbeatAt: number | null;
  readonly finishedAt: number | null;
}

export interface NewMemoryJob {
  readonly id: string;
  readonly kind: MemoryJobKind;
  readonly turnId?: string;
  readonly createdAt: number;
}

export interface MemoryJobPath {
  readonly jobId: string;
  readonly relativePath: string;
  readonly operation: MemoryJobPathOperation;
}

export interface NewMemoryJobPath {
  readonly relativePath: string;
  readonly operation: MemoryJobPathOperation;
}

export interface MemoryExtractionResult {
  readonly jobId: string;
  readonly kind: 'work_extraction' | 'relationship_extraction';
  readonly turnId: string;
  readonly content: string;
  readonly integratedAt: number | null;
}

interface MemoryJobRow {
  id: string;
  kind: MemoryJobKind;
  status: MemoryJobStatus;
  turn_id: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
}

interface MemoryJobPathRow {
  job_id: string;
  relative_path: string;
  operation: MemoryJobPathOperation;
}

interface MemoryExtractionResultRow {
  job_id: string;
  kind: 'work_extraction' | 'relationship_extraction';
  turn_id: string;
  content: string;
  integrated_at: number | null;
}

const EXTRACTION_KINDS = new Set<MemoryJobKind>([
  'work_extraction',
  'relationship_extraction',
]);

/**
 * 一行 Job 只执行一次。进程退出会把遗留 running 改成 failed；用户重试时创建
 * 新 Job，因此不需要 attempt 或另一套租约身份。
 */
export class MemoryJobsRepo {
  constructor(private readonly db: SqliteDb) {}

  enqueue(job: NewMemoryJob, paths: readonly NewMemoryJobPath[] = []): MemoryJob {
    assertTurnBinding(job.kind, job.turnId);
    return this.db.transaction(() => {
      if (EXTRACTION_KINDS.has(job.kind)) {
        const existing = this.findActiveExtraction(job.kind, job.turnId!);
        if (existing) return existing;
      }
      this.db.prepare(
        `INSERT INTO memory_jobs
           (id, kind, status, turn_id, created_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      ).run(job.id, job.kind, job.turnId ?? null, job.createdAt);
      this.insertPaths(job.id, paths);
      return this.findRequired(job.id);
    })();
  }

  /** 原子认领指定种类中最早的任务；返回 undefined 表示当前无可执行任务。 */
  claimNext(kind: MemoryJobKind, at: number): MemoryJob | undefined {
    const conflicts = runningConflicts(kind);
    const conflictSql = conflicts.length === 0
      ? ''
      : `AND NOT EXISTS (
           SELECT 1 FROM memory_jobs AS active
            WHERE active.status = 'running'
              AND active.kind IN (${conflicts.map(() => '?').join(', ')})
         )`;
    const row = this.db.prepare(
      `UPDATE memory_jobs
          SET status = 'running', started_at = ?, heartbeat_at = ?
        WHERE id = (
          SELECT candidate.id
            FROM memory_jobs AS candidate
           WHERE candidate.status = 'pending'
             AND candidate.kind = ?
             ${conflictSql}
           ORDER BY candidate.created_at, candidate.id
           LIMIT 1
        )
        RETURNING *`,
    ).get(at, at, kind, ...conflicts) as MemoryJobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  /** 返回 false 表示任务已经取消、结束或在启动恢复中被判定为中断。 */
  heartbeat(id: string, at: number): boolean {
    return this.db.prepare(
      `UPDATE memory_jobs SET heartbeat_at = ?
        WHERE id = ? AND status = 'running'`,
    ).run(at, id).changes === 1;
  }

  complete(id: string, at: number): MemoryJob | undefined {
    return this.finishRunning(id, 'completed', null, at);
  }

  /** 提取正文和 completed 终态在同一事务提交，避免断电留下半份结果。 */
  completeExtraction(id: string, content: string, at: number): MemoryJob | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        `UPDATE memory_jobs
            SET status = 'completed', error = NULL, finished_at = ?
          WHERE id = ?
            AND status = 'running'
            AND kind IN ('work_extraction', 'relationship_extraction')
          RETURNING *`,
      ).get(at, id) as MemoryJobRow | undefined;
      if (!row) return undefined;
      this.db.prepare(
        `INSERT INTO memory_extraction_results(job_id, content)
         VALUES (?, ?)`,
      ).run(id, content);
      return mapJob(row);
    })();
  }

  /** 标记本轮实际处理的提取结果，并与整合 Job 终态在同一事务提交。 */
  completeConsolidation(
    id: string,
    extractionJobIds: readonly string[],
    at: number,
  ): MemoryJob | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        `UPDATE memory_jobs
            SET status = 'completed', error = NULL, finished_at = ?
          WHERE id = ?
            AND status = 'running'
            AND kind IN ('work_consolidation', 'relationship_consolidation')
          RETURNING *`,
      ).get(at, id) as MemoryJobRow | undefined;
      if (!row) return undefined;

      const update = this.db.prepare(
        `UPDATE memory_extraction_results SET integrated_at = ?
          WHERE job_id = ? AND integrated_at IS NULL`,
      );
      for (const extractionJobId of extractionJobIds) {
        update.run(at, extractionJobId);
      }
      return mapJob(row);
    })();
  }

  fail(id: string, error: string, at: number): MemoryJob | undefined {
    return this.finishRunning(id, 'failed', error, at);
  }

  /** pending 与 running 都可取消；运行中的 Worker 会在下次心跳或收尾时发现失败。 */
  cancel(id: string, at: number): MemoryJob | undefined {
    const row = this.db.prepare(
      `UPDATE memory_jobs
          SET status = 'cancelled', error = NULL, finished_at = ?
        WHERE id = ? AND status IN ('pending', 'running')
        RETURNING *`,
    ).get(at, id) as MemoryJobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  /** 重试保留原任务事实，复制其业务身份与文件目标到一条新 pending Job。 */
  retry(failedId: string, newId: string, createdAt: number): MemoryJob | undefined {
    return this.db.transaction(() => {
      const failed = this.db.prepare(
        `SELECT * FROM memory_jobs WHERE id = ? AND status = 'failed'`,
      ).get(failedId) as MemoryJobRow | undefined;
      if (!failed) return undefined;
      this.db.prepare(
        `INSERT INTO memory_jobs
           (id, kind, status, turn_id, created_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      ).run(newId, failed.kind, failed.turn_id, createdAt);
      this.db.prepare(
        `INSERT INTO memory_job_paths(job_id, relative_path, operation)
         SELECT ?, relative_path, operation
           FROM memory_job_paths
          WHERE job_id = ?`,
      ).run(newId, failedId);
      return this.findRequired(newId);
    })();
  }

  /** 独占启动完成后调用：旧进程留下的 running 是失败记录，不自动重跑。 */
  failInterruptedRunning(at: number): number {
    return this.db.prepare(
      `UPDATE memory_jobs
          SET status = 'failed',
              error = '上次运行被应用退出中断',
              finished_at = ?
        WHERE status = 'running'`,
    ).run(at).changes;
  }

  /** 整合 Job 在写文件前一次性登记实际目标；终态历史仍保留这些关系。 */
  setRunningPaths(id: string, paths: readonly NewMemoryJobPath[]): boolean {
    return this.db.transaction(() => {
      const running = this.db.prepare(
        `SELECT 1 FROM memory_jobs WHERE id = ? AND status = 'running'`,
      ).get(id);
      if (!running) return false;
      this.db.prepare('DELETE FROM memory_job_paths WHERE job_id = ?').run(id);
      this.insertPaths(id, paths);
      return true;
    })();
  }

  findById(id: string): MemoryJob | undefined {
    const row = this.db.prepare('SELECT * FROM memory_jobs WHERE id = ?')
      .get(id) as MemoryJobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  /**
   * 该轨最近一次整合 completed 的 finished_at；从未成功整合过返回 undefined。
   * 只查整合 kind——提取/维护的完成时间不能当作整合冷却基准。
   */
  lastCompletedAt(
    kind: 'work_consolidation' | 'relationship_consolidation',
  ): number | undefined {
    const row = this.db.prepare(
      `SELECT MAX(finished_at) AS finished_at
         FROM memory_jobs
        WHERE kind = ? AND status = 'completed'`,
    ).get(kind) as { finished_at: number | null } | undefined;
    return row?.finished_at ?? undefined;
  }

  listRecent(limit = 100): MemoryJob[] {
    return (this.db.prepare(
      `SELECT * FROM memory_jobs
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).all(limit) as MemoryJobRow[]).map(mapJob);
  }

  listPaths(id: string): MemoryJobPath[] {
    return (this.db.prepare(
      `SELECT job_id, relative_path, operation
         FROM memory_job_paths
        WHERE job_id = ?
        ORDER BY relative_path`,
    ).all(id) as MemoryJobPathRow[]).map(mapPath);
  }

  listBusyPaths(): MemoryJobPath[] {
    return (this.db.prepare(
      `SELECT target.job_id, target.relative_path, target.operation
         FROM memory_job_paths AS target
         JOIN memory_jobs AS job ON job.id = target.job_id
        WHERE job.status = 'running'
        ORDER BY target.relative_path, target.job_id`,
    ).all() as MemoryJobPathRow[]).map(mapPath);
  }

  listUnintegratedExtractionResults(
    kind: 'work_extraction' | 'relationship_extraction',
    limit: number,
  ): MemoryExtractionResult[] {
    return (this.db.prepare(
      `SELECT result.job_id, job.kind, job.turn_id, result.content, result.integrated_at
         FROM memory_extraction_results AS result
         JOIN memory_jobs AS job ON job.id = result.job_id
        WHERE job.kind = ? AND result.integrated_at IS NULL
        ORDER BY job.created_at, job.id
        LIMIT ?`,
    ).all(kind, limit) as MemoryExtractionResultRow[]).map(mapExtractionResult);
  }

  private finishRunning(
    id: string,
    status: 'completed' | 'failed',
    error: string | null,
    at: number,
  ): MemoryJob | undefined {
    const row = this.db.prepare(
      `UPDATE memory_jobs
          SET status = ?, error = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
        RETURNING *`,
    ).get(status, error, at, id) as MemoryJobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  private insertPaths(id: string, paths: readonly NewMemoryJobPath[]): void {
    const insert = this.db.prepare(
      `INSERT INTO memory_job_paths(job_id, relative_path, operation)
       VALUES (?, ?, ?)`,
    );
    for (const target of paths) {
      insert.run(id, target.relativePath, target.operation);
    }
  }

  private findActiveExtraction(
    kind: MemoryJobKind,
    turnId: string,
  ): MemoryJob | undefined {
    const row = this.db.prepare(
      `SELECT * FROM memory_jobs
        WHERE kind = ?
          AND turn_id = ?
          AND status IN ('pending', 'running', 'completed')
        ORDER BY created_at, id
        LIMIT 1`,
    ).get(kind, turnId) as MemoryJobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  private findRequired(id: string): MemoryJob {
    const row = this.findById(id);
    if (!row) throw new Error(`Memory job not found after insert: ${id}`);
    return row;
  }
}

function assertTurnBinding(kind: MemoryJobKind, turnId: string | undefined): void {
  const requiresTurn = EXTRACTION_KINDS.has(kind);
  if (requiresTurn !== (turnId !== undefined)) {
    throw new Error(
      requiresTurn
        ? `${kind} requires turnId`
        : `${kind} must not carry turnId`,
    );
  }
}

function runningConflicts(kind: MemoryJobKind): readonly MemoryJobKind[] {
  switch (kind) {
    case 'work_extraction':
    case 'relationship_extraction':
      return [];
    case 'work_consolidation':
      return ['work_consolidation', 'clear_memory', 'storage_cleanup'];
    case 'relationship_consolidation':
      return ['relationship_consolidation', 'clear_memory', 'storage_cleanup'];
    case 'clear_memory':
    case 'storage_cleanup':
      return [
        'work_consolidation',
        'relationship_consolidation',
        'clear_memory',
        'storage_cleanup',
      ];
  }
}

function mapJob(row: MemoryJobRow): MemoryJob {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    turnId: row.turn_id,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
  };
}

function mapPath(row: MemoryJobPathRow): MemoryJobPath {
  return {
    jobId: row.job_id,
    relativePath: row.relative_path,
    operation: row.operation,
  };
}

function mapExtractionResult(row: MemoryExtractionResultRow): MemoryExtractionResult {
  return {
    jobId: row.job_id,
    kind: row.kind,
    turnId: row.turn_id,
    content: row.content,
    integratedAt: row.integrated_at,
  };
}

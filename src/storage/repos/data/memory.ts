import type { SqliteDb } from '../../database/database.js';

export type MemoryExtractionJobKind = 'work_extraction' | 'relationship_extraction';
export type MemoryConsolidationJobKind = 'work_consolidation' | 'relationship_consolidation';
export type MemoryMaintenanceJobKind = 'work_maintenance' | 'relationship_maintenance';
export type MemoryJobKind =
  | MemoryExtractionJobKind
  | MemoryConsolidationJobKind
  | MemoryMaintenanceJobKind;
export type MemoryJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface MemoryJob {
  readonly id: string;
  readonly kind: MemoryJobKind;
  readonly status: MemoryJobStatus;
  readonly turnId: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly reminderIgnored: boolean;
}

export type MemoryJobResult =
  | 'no_content'
  | 'awaiting_consolidation'
  | 'consolidated'
  | 'consolidation_completed'
  | 'maintenance_completed';

export interface MemoryJobRecord extends Pick<MemoryJob,
  'id' | 'kind' | 'status' | 'createdAt' | 'reminderIgnored'
> {
  readonly characterName: string | null;
  readonly result: MemoryJobResult | null;
}

export interface MemoryJobDetail extends MemoryJobRecord {
  readonly error: string | null;
  readonly content: string | null;
}

export interface MemoryJobCursor {
  readonly createdAt: number;
  readonly id: string;
  readonly direction: 'next' | 'previous';
}

export interface MemoryJobPageRequest {
  readonly startAt?: number;
  readonly endAt?: number;
  readonly order: 'asc' | 'desc';
  readonly page: number;
  readonly cursor?: MemoryJobCursor;
}

export interface MemoryJobPage {
  readonly items: readonly MemoryJobRecord[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly previousCursor: MemoryJobCursor | null;
  readonly nextCursor: MemoryJobCursor | null;
  // 忽略按钮针对全部失败提醒, 不受日期范围或当前页限制.
  readonly unignoredFailureCount: number;
}

export const MEMORY_JOB_PAGE_SIZE = 6;

export interface WorkMemoryExtraction {
  readonly turnId: string;
  readonly sessionId: string;
  readonly content: string;
  readonly integratedAt: number | null;
  readonly createdAt: number;
}

export interface RelationshipMemoryExtraction extends WorkMemoryExtraction {
  readonly characterName: string;
}

export interface MemoryExtractionReadiness {
  readonly count: number;
  readonly oldestCreatedAt: number | null;
}

interface MemoryJobRow {
  id: string;
  kind: MemoryJobKind;
  status: MemoryJobStatus;
  turn_id: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  reminder_ignored: number;
}

interface MemoryJobRecordRow {
  id: string;
  kind: MemoryJobKind;
  status: MemoryJobStatus;
  created_at: number;
  reminder_ignored: number;
  character_name: string | null;
  extraction_job_id: string | null;
  integrated_at: number | null;
}

interface MemoryJobDetailRow extends MemoryJobRecordRow {
  error: string | null;
  content: string | null;
}

const JOB_RECORD_COLUMNS = `job.id, job.kind, job.status, job.created_at,
  job.reminder_ignored,
  COALESCE(relationship.character_name, turn.character_name) AS character_name,
  COALESCE(work.job_id, relationship.job_id) AS extraction_job_id,
  COALESCE(work.integrated_at, relationship.integrated_at) AS integrated_at`;

const JOB_RECORD_JOINS = `FROM memory_jobs AS job
  LEFT JOIN memory_work_extractions AS work ON work.job_id = job.id
  LEFT JOIN memory_relationship_extractions AS relationship ON relationship.job_id = job.id
  LEFT JOIN turns AS turn ON turn.id = job.turn_id`;

interface WorkExtractionRow {
  turn_id: string;
  session_id: string;
  content: string;
  integrated_at: number | null;
  created_at: number;
}

interface RelationshipExtractionRow extends WorkExtractionRow {
  character_name: string;
}

export class MemoryRepo {
  constructor(private readonly db: SqliteDb) {}

  enqueueExtraction(
    id: string,
    kind: MemoryExtractionJobKind,
    turnId: string,
    createdAt: number,
  ): MemoryJob {
    return this.db.transaction(() => {
      const existing = this.findExtractionForTurn(kind, turnId);
      if (existing) return existing;
      this.insertPending(id, kind, turnId, createdAt);
      return this.findRequired(id);
    })();
  }

  enqueueConsolidationIfAbsent(
    id: string,
    kind: MemoryConsolidationJobKind,
    createdAt: number,
  ): MemoryJob {
    return this.db.transaction(() => {
      const existing = this.findActiveKind(kind);
      if (existing) return existing;
      this.insertPending(id, kind, null, createdAt);
      return this.findRequired(id);
    })();
  }

  /** Maintenance 到点时只在同轨没有文件任务时创建, 跳过不留下空历史. */
  startMaintenanceIfIdle(
    id: string,
    kind: MemoryMaintenanceJobKind,
    at: number,
  ): MemoryJob | undefined {
    return this.db.transaction(() => {
      const [consolidationKind] = trackKinds(kind);
      const conflict = this.db.prepare(
        `SELECT 1 FROM memory_jobs
          WHERE kind IN (?, ?)
            AND status IN ('pending', 'running')
          LIMIT 1`,
      ).get(consolidationKind, kind);
      if (conflict) return undefined;
      this.db.prepare(
        `INSERT INTO memory_jobs
           (id, kind, status, turn_id, created_at, started_at)
         VALUES (?, ?, 'running', NULL, ?, ?)`,
      ).run(id, kind, at, at);
      return this.findRequired(id);
    })();
  }

  claimNext(kind: MemoryJobKind, at: number): MemoryJob | undefined {
    const conflicts = claimConflicts(kind);
    const conflictSql = conflicts.length === 0
      ? ''
      : `AND NOT EXISTS (
           SELECT 1 FROM memory_jobs AS active
            WHERE active.status = 'running'
              AND active.kind IN (${conflicts.map(() => '?').join(', ')})
         )`;
    const row = this.db.prepare(
      `UPDATE memory_jobs
          SET status = 'running', started_at = ?, error = NULL, finished_at = NULL
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
    ).get(at, kind, ...conflicts) as MemoryJobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  complete(id: string, at: number): MemoryJob | undefined {
    return this.finish(id, 'completed', null, at);
  }

  completeWorkExtraction(
    jobId: string,
    sessionId: string,
    content: string,
    at: number,
  ): MemoryJob | undefined {
    return this.completeExtraction(jobId, at, row => {
      this.db.prepare(
        `INSERT INTO memory_work_extractions
           (turn_id, job_id, session_id, content)
         VALUES (?, ?, ?, ?)`,
      ).run(row.turn_id, jobId, sessionId, content);
    });
  }

  completeRelationshipExtraction(
    jobId: string,
    sessionId: string,
    characterName: string,
    content: string,
    at: number,
  ): MemoryJob | undefined {
    return this.completeExtraction(jobId, at, row => {
      this.db.prepare(
        `INSERT INTO memory_relationship_extractions
           (turn_id, job_id, session_id, character_name, content)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(row.turn_id, jobId, sessionId, characterName, content);
    });
  }

  completeConsolidation(
    jobId: string,
    consumedTurnIds: readonly string[],
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
      ).get(at, jobId) as MemoryJobRow | undefined;
      if (!row) return undefined;
      const table = row.kind === 'work_consolidation'
        ? 'memory_work_extractions'
        : 'memory_relationship_extractions';
      const update = this.db.prepare(
        `UPDATE ${table} SET integrated_at = ?
          WHERE turn_id = ? AND integrated_at IS NULL`,
      );
      for (const turnId of consumedTurnIds) update.run(at, turnId);
      return mapJob(row);
    })();
  }

  fail(id: string, error: string, at: number): MemoryJob | undefined {
    return this.finish(id, 'failed', error, at);
  }

  requeueInterrupted(): number {
    return this.db.prepare(
      `UPDATE memory_jobs
          SET status = 'pending', started_at = NULL, error = NULL, finished_at = NULL
        WHERE status = 'running'`,
    ).run().changes;
  }

  findById(id: string): MemoryJob | undefined {
    const row = this.db.prepare('SELECT * FROM memory_jobs WHERE id = ?')
      .get(id) as MemoryJobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  listRecent(limit: number): MemoryJobRecord[] {
    const rows = this.db.prepare(
      `SELECT ${JOB_RECORD_COLUMNS} ${JOB_RECORD_JOINS}
       ORDER BY job.created_at DESC, job.id DESC LIMIT ?`,
    ).all(limit) as MemoryJobRecordRow[];
    return rows.map(mapJobRecord);
  }

  listPage(request: MemoryJobPageRequest): MemoryJobPage {
    const conditions: string[] = [];
    const parameters: (string | number)[] = [];
    if (request.startAt !== undefined) {
      conditions.push('job.created_at >= ?');
      parameters.push(request.startAt);
    }
    if (request.endAt !== undefined) {
      conditions.push('job.created_at < ?');
      parameters.push(request.endAt);
    }
    const where = conditions.length > 0 ? conditions.join(' AND ') : '1 = 1';
    const { total } = this.db.prepare(
      `SELECT COUNT(*) AS total FROM memory_jobs AS job WHERE ${where}`,
    ).get(...parameters) as { total: number };
    const pageCount = Math.max(1, Math.ceil(total / MEMORY_JOB_PAGE_SIZE));
    const page = Math.min(request.page, pageCount);
    const order = request.order === 'asc' ? 'ASC' : 'DESC';
    let cursor = page === request.page ? request.cursor : undefined;

    if (!cursor && page > 1) {
      // 跳到尚未访问的页时, 只查该页前一条记录的排序键, 不加载前面所有任务正文.
      // OFFSET 仍会跳过前面的索引项; 相邻翻页使用返回的游标, 不走这条查询.
      const anchor = this.db.prepare(
        `SELECT job.id, job.created_at FROM memory_jobs AS job
         WHERE ${where} ORDER BY job.created_at ${order}, job.id ${order}
         LIMIT 1 OFFSET ?`,
      ).get(...parameters, (page - 1) * MEMORY_JOB_PAGE_SIZE - 1) as
        { id: string; created_at: number };
      cursor = { id: anchor.id, createdAt: anchor.created_at, direction: 'next' };
    }

    let cursorCondition = '';
    let queryOrder = order;
    if (cursor) {
      const forward = cursor.direction === 'next';
      const comparison = (request.order === 'asc') === forward ? '>' : '<';
      cursorCondition = `AND (job.created_at, job.id) ${comparison} (?, ?)`;
      parameters.push(cursor.createdAt, cursor.id);
      if (!forward) queryOrder = order === 'ASC' ? 'DESC' : 'ASC';
    }
    const rows = this.db.prepare(
      `SELECT ${JOB_RECORD_COLUMNS} ${JOB_RECORD_JOINS}
       WHERE ${where} ${cursorCondition}
       ORDER BY job.created_at ${queryOrder}, job.id ${queryOrder} LIMIT ?`,
    ).all(...parameters, MEMORY_JOB_PAGE_SIZE) as MemoryJobRecordRow[];
    if (cursor?.direction === 'previous') rows.reverse();
    const first = rows[0];
    const last = rows.at(-1);
    return {
      items: rows.map(mapJobRecord),
      page,
      pageSize: MEMORY_JOB_PAGE_SIZE,
      total,
      previousCursor: page > 1 && first
        ? { id: first.id, createdAt: first.created_at, direction: 'previous' }
        : null,
      nextCursor: page < pageCount && last
        ? { id: last.id, createdAt: last.created_at, direction: 'next' }
        : null,
      unignoredFailureCount: this.countUnignoredFailures(),
    };
  }

  findDetail(id: string): MemoryJobDetail | undefined {
    const row = this.db.prepare(
      `SELECT ${JOB_RECORD_COLUMNS}, job.error,
              COALESCE(work.content, relationship.content) AS content
       ${JOB_RECORD_JOINS} WHERE job.id = ?`,
    ).get(id) as MemoryJobDetailRow | undefined;
    if (!row) return undefined;
    return { ...mapJobRecord(row), error: row.error, content: row.content };
  }

  countUnignoredFailures(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM memory_jobs
       WHERE status = 'failed' AND reminder_ignored = 0`,
    ).get() as { count: number };
    return row.count;
  }

  ignoreFailure(id: string): boolean {
    const row = this.db.prepare(
      `UPDATE memory_jobs SET reminder_ignored = 1
       WHERE id = ? AND status = 'failed' RETURNING id`,
    ).get(id);
    return row !== undefined;
  }

  ignoreAllFailures(): void {
    this.db.prepare(
      `UPDATE memory_jobs SET reminder_ignored = 1
       WHERE status = 'failed' AND reminder_ignored = 0`,
    ).run();
  }

  workReadiness(): MemoryExtractionReadiness {
    return this.readiness('memory_work_extractions');
  }

  relationshipReadiness(): MemoryExtractionReadiness {
    return this.readiness('memory_relationship_extractions');
  }

  listUnintegratedWork(limit: number): WorkMemoryExtraction[] {
    return (this.db.prepare(
      `SELECT result.turn_id, result.session_id, result.content,
              result.integrated_at, job.created_at
         FROM memory_work_extractions AS result
         JOIN memory_jobs AS job ON job.id = result.job_id
        WHERE result.integrated_at IS NULL
        ORDER BY job.created_at, result.turn_id
        LIMIT ?`,
    ).all(limit) as WorkExtractionRow[]).map(mapWorkExtraction);
  }

  listUnintegratedRelationship(limit: number): RelationshipMemoryExtraction[] {
    return (this.db.prepare(
      `SELECT result.turn_id, result.session_id, result.character_name,
              result.content, result.integrated_at, job.created_at
         FROM memory_relationship_extractions AS result
         JOIN memory_jobs AS job ON job.id = result.job_id
        WHERE result.integrated_at IS NULL
        ORDER BY job.created_at, result.turn_id
        LIMIT ?`,
    ).all(limit) as RelationshipExtractionRow[]).map(mapRelationshipExtraction);
  }

  private completeExtraction(
    jobId: string,
    at: number,
    insertResult: (row: MemoryJobRow) => void,
  ): MemoryJob | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        `UPDATE memory_jobs
            SET status = 'completed', error = NULL, finished_at = ?
          WHERE id = ?
            AND status = 'running'
            AND kind IN ('work_extraction', 'relationship_extraction')
          RETURNING *`,
      ).get(at, jobId) as MemoryJobRow | undefined;
      if (!row || !row.turn_id) return undefined;
      insertResult(row);
      return mapJob(row);
    })();
  }

  private finish(
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

  private insertPending(
    id: string,
    kind: MemoryJobKind,
    turnId: string | null,
    createdAt: number,
  ): void {
    this.db.prepare(
      `INSERT INTO memory_jobs (id, kind, status, turn_id, created_at)
       VALUES (?, ?, 'pending', ?, ?)`,
    ).run(id, kind, turnId, createdAt);
  }

  private findExtractionForTurn(
    kind: MemoryExtractionJobKind,
    turnId: string,
  ): MemoryJob | undefined {
    const row = this.db.prepare(
      'SELECT * FROM memory_jobs WHERE kind = ? AND turn_id = ?',
    ).get(kind, turnId) as MemoryJobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  private findActiveKind(kind: MemoryJobKind): MemoryJob | undefined {
    const row = this.db.prepare(
      `SELECT * FROM memory_jobs
        WHERE kind = ? AND status IN ('pending', 'running')
        LIMIT 1`,
    ).get(kind) as MemoryJobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  private findRequired(id: string): MemoryJob {
    const job = this.findById(id);
    if (!job) throw new Error(`Memory job not found after insert: ${id}`);
    return job;
  }

  private readiness(table: string): MemoryExtractionReadiness {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count, MIN(job.created_at) AS oldest_created_at
         FROM ${table} AS result
         JOIN memory_jobs AS job ON job.id = result.job_id
        WHERE result.integrated_at IS NULL`,
    ).get() as { count: number; oldest_created_at: number | null };
    return { count: row.count, oldestCreatedAt: row.oldest_created_at };
  }

}

function trackKinds(
  kind: MemoryMaintenanceJobKind,
): readonly [MemoryConsolidationJobKind, MemoryMaintenanceJobKind] {
  return kind === 'work_maintenance'
    ? ['work_consolidation', 'work_maintenance']
    : ['relationship_consolidation', 'relationship_maintenance'];
}

function claimConflicts(kind: MemoryJobKind): readonly MemoryJobKind[] {
  switch (kind) {
    case 'work_extraction':
    case 'relationship_extraction':
      return [];
    case 'work_consolidation':
      return ['work_consolidation', 'work_maintenance'];
    case 'relationship_consolidation':
      return ['relationship_consolidation', 'relationship_maintenance'];
    case 'work_maintenance':
      return ['work_consolidation', 'work_maintenance'];
    case 'relationship_maintenance':
      return ['relationship_consolidation', 'relationship_maintenance'];
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
    finishedAt: row.finished_at,
    reminderIgnored: row.reminder_ignored === 1,
  };
}

function mapJobRecord(row: MemoryJobRecordRow): MemoryJobRecord {
  let result: MemoryJobResult | null = null;
  if (row.status === 'completed') {
    switch (row.kind) {
      case 'work_extraction':
      case 'relationship_extraction':
        if (row.extraction_job_id === null) {
          result = 'no_content';
        } else if (row.integrated_at === null) {
          result = 'awaiting_consolidation';
        } else {
          result = 'consolidated';
        }
        break;
      case 'work_consolidation':
      case 'relationship_consolidation':
        result = 'consolidation_completed';
        break;
      case 'work_maintenance':
      case 'relationship_maintenance':
        result = 'maintenance_completed';
        break;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    reminderIgnored: row.reminder_ignored === 1,
    characterName: row.character_name,
    result,
  };
}

function mapWorkExtraction(row: WorkExtractionRow): WorkMemoryExtraction {
  return {
    turnId: row.turn_id,
    sessionId: row.session_id,
    content: row.content,
    integratedAt: row.integrated_at,
    createdAt: row.created_at,
  };
}

function mapRelationshipExtraction(
  row: RelationshipExtractionRow,
): RelationshipMemoryExtraction {
  return {
    ...mapWorkExtraction(row),
    characterName: row.character_name,
  };
}

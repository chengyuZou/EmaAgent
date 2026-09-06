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
}

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
}

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

  /** Maintenance 到点时只在同轨没有文件任务时创建，跳过不留下空历史。 */
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

  listCurrent(limit = 100): MemoryJob[] {
    return this.listByStatus(
      `status IN ('pending', 'running', 'failed')`,
      'created_at DESC, id DESC',
      limit,
    );
  }

  listHistory(limit = 100): MemoryJob[] {
    return this.listByStatus(
      `status IN ('completed', 'failed')`,
      'finished_at DESC, id DESC',
      limit,
    );
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

  private listByStatus(where: string, order: string, limit: number): MemoryJob[] {
    return (this.db.prepare(
      `SELECT * FROM memory_jobs WHERE ${where} ORDER BY ${order} LIMIT ?`,
    ).all(limit) as MemoryJobRow[]).map(mapJob);
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

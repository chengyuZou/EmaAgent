import type { SqliteDb } from '../database.js';

export type KbIngestStatus = 'pending' | 'running' | 'failed';

export interface KbIngestTaskRow {
  id:         string;
  file_path:  string;
  file_name:  string;
  mime_type:  string | null;
  status:     KbIngestStatus;
  stage:      string | null;
  progress:   number;
  error:      string | null;
  created_at: number;
  updated_at: number;
}

export interface KbIngestTask {
  id:        string;
  filePath:  string;
  fileName:  string;
  mimeType?: string;
  status:    KbIngestStatus;
  stage?:    string;
  progress:  number;
  error?:    string;
  createdAt: number;
  updatedAt: number;
}

function rowToTask(r: KbIngestTaskRow): KbIngestTask {
  return {
    id:        r.id,
    filePath:  r.file_path,
    fileName:  r.file_name,
    mimeType:  r.mime_type ?? undefined,
    status:    r.status,
    stage:     r.stage ?? undefined,
    progress:  r.progress,
    error:     r.error ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class KbIngestTasksRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(t: { id: string; filePath: string; fileName: string; mimeType?: string }): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO kb_ingest_tasks (id, file_path, file_name, mime_type, status, progress, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ).run(t.id, t.filePath, t.fileName, t.mimeType ?? null, now, now);
  }

  /** Atomically take the oldest pending task and mark it running. Single-threaded
   *  (Node + sync sqlite) so a transaction is enough to avoid double-claim. */
  claimNextPending(): KbIngestTask | undefined {
    return this.db.transaction((): KbIngestTask | undefined => {
      const row = this.db
        .prepare(`SELECT * FROM kb_ingest_tasks WHERE status = 'pending' ORDER BY created_at LIMIT 1`)
        .get() as KbIngestTaskRow | undefined;
      if (!row) return undefined;
      this.db.prepare(`UPDATE kb_ingest_tasks SET status = 'running', updated_at = ? WHERE id = ?`)
        .run(Date.now(), row.id);
      return rowToTask({ ...row, status: 'running' });
    })();
  }

  updateProgress(id: string, stage: string, progress: number): void {
    this.db.prepare(`UPDATE kb_ingest_tasks SET stage = ?, progress = ?, updated_at = ? WHERE id = ?`)
      .run(stage, progress, Date.now(), id);
  }

  /** Success → remove the task (the document now lives in document_assets). */
  complete(id: string): void {
    this.db.prepare(`DELETE FROM kb_ingest_tasks WHERE id = ?`).run(id);
  }

  fail(id: string, error: string): void {
    this.db.prepare(`UPDATE kb_ingest_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
      .run(error, Date.now(), id);
  }

  /** Retry a failed task → back to pending. */
  setPending(id: string): void {
    this.db.prepare(`UPDATE kb_ingest_tasks SET status = 'pending', error = NULL, progress = 0, stage = NULL, updated_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  }

  /** Active queue (pending / running / failed) for the UI, newest first. */
  listActive(): KbIngestTask[] {
    const rows = this.db
      .prepare(`SELECT * FROM kb_ingest_tasks ORDER BY created_at DESC`)
      .all() as KbIngestTaskRow[];
    return rows.map(rowToTask);
  }

  get(id: string): KbIngestTask | undefined {
    const row = this.db.prepare(`SELECT * FROM kb_ingest_tasks WHERE id = ?`).get(id) as KbIngestTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /** Crash recovery: any task left 'running' by a previous process → failed. */
  recoverStuck(): number {
    const info = this.db.prepare(
      `UPDATE kb_ingest_tasks SET status = 'failed', error = '应用重启中断，可重试', updated_at = ? WHERE status = 'running'`,
    ).run(Date.now());
    return info.changes;
  }
}

// 持久化单进程 Knowledge 导入任务及其可展示进度。

import type { SqliteDb } from '../../database/database.js';

export type KbIngestStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

interface KbIngestTaskRow {
  id: string; asset_id: string; source_path: string; file_path: string; file_name: string;
  mime_type: string | null; status: KbIngestStatus; stage: string | null;
  progress: number; error: string | null; created_at: number; updated_at: number;
}

export interface KbIngestTask {
  readonly id: string; readonly assetId: string; readonly sourcePath: string;
  readonly filePath: string;
  readonly fileName: string; readonly mimeType?: string; readonly status: KbIngestStatus;
  readonly stage?: string; readonly progress: number; readonly error?: string;
  readonly createdAt: number; readonly updatedAt: number;
}

export class KbIngestTasksRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(task: { id: string; assetId: string; sourcePath: string; filePath: string; fileName: string; mimeType?: string }): KbIngestTask {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO kb_ingest_tasks
       (id, asset_id, source_path, file_path, file_name, mime_type, status, progress, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ).run(task.id, task.assetId, task.sourcePath, task.filePath, task.fileName, task.mimeType ?? null, now, now);
    return this.get(task.id)!;
  }

  startNext(): KbIngestTask | undefined {
    const row = this.db.prepare(
      `UPDATE kb_ingest_tasks
          SET status = 'running', stage = 'validate', progress = 0, error = NULL, updated_at = ?
        WHERE id = (SELECT id FROM kb_ingest_tasks WHERE status = 'pending'
                     ORDER BY created_at ASC, id ASC LIMIT 1)
          AND status = 'pending' RETURNING *`,
    ).get(Date.now()) as KbIngestTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  updateProgress(id: string, stage: string, progress: number): boolean {
    return this.db.prepare(
      `UPDATE kb_ingest_tasks SET stage = ?, progress = ?, updated_at = ?
        WHERE id = ? AND status = 'running'`,
    ).run(stage, Math.min(1, Math.max(0, progress)), Date.now(), id).changes === 1;
  }

  complete(id: string): boolean { return this.finish(id, 'completed'); }
  fail(id: string, error: string): boolean { return this.finish(id, 'failed', error); }

  cancel(id: string): boolean {
    return this.db.prepare(
      `UPDATE kb_ingest_tasks SET status = 'cancelled', error = NULL, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'running')`,
    ).run(Date.now(), id).changes === 1;
  }

  /** 在途任务计数(库卡"N 个任务在跑")。 */
  countActive(): number {
    return this.db.prepare(
      `SELECT COUNT(*) FROM kb_ingest_tasks WHERE status IN ('pending', 'running')`,
    ).pluck().get() as number;
  }

  /** 删除终态任务行;在途任务由队列层拒绝(先取消再删)。 */
  delete(id: string): boolean {
    return this.db.prepare(
      `DELETE FROM kb_ingest_tasks WHERE id = ? AND status IN ('completed', 'failed', 'cancelled')`,
    ).run(id).changes === 1;
  }

  /** 文档删除时级联清掉它的全部任务行。 */
  deleteByAssetId(assetId: string): number {
    return this.db.prepare('DELETE FROM kb_ingest_tasks WHERE asset_id = ?').run(assetId).changes;
  }

  markRunningInterrupted(at = Date.now()): number {
    return this.db.prepare(
      `UPDATE kb_ingest_tasks SET status = 'failed', error = '上次运行被应用退出中断', updated_at = ?
        WHERE status = 'running'`,
    ).run(at).changes;
  }

  get(id: string): KbIngestTask | undefined {
    const row = this.db.prepare('SELECT * FROM kb_ingest_tasks WHERE id = ?').get(id) as KbIngestTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  findLatestByAssetId(assetId: string): KbIngestTask | undefined {
    const row = this.db.prepare(
      `SELECT * FROM kb_ingest_tasks WHERE asset_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(assetId) as KbIngestTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  list(): KbIngestTask[] {
    return (this.db.prepare('SELECT * FROM kb_ingest_tasks ORDER BY created_at DESC, id DESC').all() as KbIngestTaskRow[])
      .map(rowToTask);
  }

  private finish(id: string, status: 'completed' | 'failed', error?: string): boolean {
    return this.db.prepare(
      `UPDATE kb_ingest_tasks SET status = ?, stage = NULL, progress = 1, error = ?, updated_at = ?
        WHERE id = ? AND status = 'running'`,
    ).run(status, error ?? null, Date.now(), id).changes === 1;
  }
}

function rowToTask(row: KbIngestTaskRow): KbIngestTask {
  return {
    id: row.id, assetId: row.asset_id, sourcePath: row.source_path,
    filePath: row.file_path, fileName: row.file_name,
    ...(row.mime_type === null ? {} : { mimeType: row.mime_type }), status: row.status,
    ...(row.stage === null ? {} : { stage: row.stage }), progress: row.progress,
    ...(row.error === null ? {} : { error: row.error }), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

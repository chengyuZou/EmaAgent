// 持久化单进程 Knowledge 重嵌入任务及其冻结模型身份。

import type { SqliteDb } from '../../database/database.js';

export type KbReembedStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

interface KbReembedTaskRow {
  id: string; asset_id: string | null; embedding_provider_config_id: string; embedding_model: string;
  status: KbReembedStatus; stage: string | null; progress: number; error: string | null;
  created_at: number; updated_at: number;
}

export interface KbReembedTask {
  readonly id: string; readonly assetId?: string; readonly embeddingProviderConfigId: string;
  readonly embeddingModel: string; readonly status: KbReembedStatus; readonly stage?: string;
  readonly progress: number; readonly error?: string; readonly createdAt: number; readonly updatedAt: number;
}

export class KbReembedTasksRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(task: { id: string; assetId?: string; embeddingProviderConfigId: string; embeddingModel: string }): KbReembedTask {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO kb_reembed_tasks
       (id, asset_id, embedding_provider_config_id, embedding_model, status, progress, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ).run(task.id, task.assetId ?? null, task.embeddingProviderConfigId, task.embeddingModel, now, now);
    return this.get(task.id)!;
  }

  startNext(): KbReembedTask | undefined {
    const row = this.db.prepare(
      `UPDATE kb_reembed_tasks
          SET status = 'running', stage = 'embed', progress = 0, error = NULL, updated_at = ?
        WHERE id = (SELECT id FROM kb_reembed_tasks WHERE status = 'pending'
                     ORDER BY created_at ASC, id ASC LIMIT 1)
          AND status = 'pending' RETURNING *`,
    ).get(Date.now()) as KbReembedTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  updateProgress(id: string, progress: number): boolean {
    return this.db.prepare(
      `UPDATE kb_reembed_tasks SET stage = 'embed', progress = ?, updated_at = ?
        WHERE id = ? AND status = 'running'`,
    ).run(Math.min(1, Math.max(0, progress)), Date.now(), id).changes === 1;
  }

  complete(id: string): boolean { return this.finish(id, 'completed'); }
  fail(id: string, error: string): boolean { return this.finish(id, 'failed', error); }

  cancel(id: string): boolean {
    return this.db.prepare(
      `UPDATE kb_reembed_tasks SET status = 'cancelled', error = NULL, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'running')`,
    ).run(Date.now(), id).changes === 1;
  }

  markRunningInterrupted(at = Date.now()): number {
    return this.db.prepare(
      `UPDATE kb_reembed_tasks SET status = 'failed', error = '上次运行被应用退出中断', updated_at = ?
        WHERE status = 'running'`,
    ).run(at).changes;
  }

  get(id: string): KbReembedTask | undefined {
    const row = this.db.prepare('SELECT * FROM kb_reembed_tasks WHERE id = ?').get(id) as KbReembedTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  list(): KbReembedTask[] {
    return (this.db.prepare('SELECT * FROM kb_reembed_tasks ORDER BY created_at DESC, id DESC').all() as KbReembedTaskRow[])
      .map(rowToTask);
  }

  private finish(id: string, status: 'completed' | 'failed', error?: string): boolean {
    return this.db.prepare(
      `UPDATE kb_reembed_tasks SET status = ?, stage = NULL, progress = 1, error = ?, updated_at = ?
        WHERE id = ? AND status = 'running'`,
    ).run(status, error ?? null, Date.now(), id).changes === 1;
  }
}

function rowToTask(row: KbReembedTaskRow): KbReembedTask {
  return {
    id: row.id, ...(row.asset_id === null ? {} : { assetId: row.asset_id }),
    embeddingProviderConfigId: row.embedding_provider_config_id,
    embeddingModel: row.embedding_model, status: row.status,
    ...(row.stage === null ? {} : { stage: row.stage }), progress: row.progress,
    ...(row.error === null ? {} : { error: row.error }), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

import type { SqliteDb } from '../../database/database.js';
import { createSqliteIdBatches } from '../../database/sqlite-id-batches.js';

export type NarrativeTimelineId = '1st_Loop' | '2nd_Loop' | '3rd_Loop';

export interface NarrativeChunkVectorRow {
  chunk_id: string;
  vector: Buffer;
}

export interface NarrativeChunkRow {
  chunk_id: string;
  content: string;
}

export class NarrativeChunksRepo {
  constructor(private readonly db: SqliteDb) {}

  listVectors(timelineId: NarrativeTimelineId): NarrativeChunkVectorRow[] {
    return this.db.prepare(`
      SELECT chunk_id, vector FROM chunks
      WHERE timeline_id = ? ORDER BY rowid
    `).all(timelineId) as NarrativeChunkVectorRow[];
  }

  /** 图召回已确定候选时只读这些块的向量, 不读正文. 去重后保留输入顺序, 忽略不存在的 ID. */
  findVectorsByIds(timelineId: NarrativeTimelineId, chunkIds: readonly string[]): NarrativeChunkVectorRow[] {
    const found = new Map<string, NarrativeChunkVectorRow>();
    for (const batch of createSqliteIdBatches(this.db, chunkIds, { fixedParameterCount: 1 })) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT chunk_id, vector FROM chunks
        WHERE timeline_id = ? AND chunk_id IN (${placeholders})
      `).all(timelineId, ...batch) as NarrativeChunkVectorRow[];
      for (const row of rows) {
        found.set(row.chunk_id, row);
      }
    }
    const result: NarrativeChunkVectorRow[] = [];
    for (const id of new Set(chunkIds)) {
      const row = found.get(id);
      if (row !== undefined) {
        result.push(row);
      }
    }
    return result;
  }

  /** 按传入 ID 的首次出现顺序返回, 忽略不存在的块; 不读取向量. */
  findChunksByIds(timelineId: NarrativeTimelineId, chunkIds: readonly string[]): NarrativeChunkRow[] {
    const found = new Map<string, NarrativeChunkRow>();
    for (const batch of createSqliteIdBatches(this.db, chunkIds, { fixedParameterCount: 1 })) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT chunk_id, content FROM chunks
        WHERE timeline_id = ? AND chunk_id IN (${placeholders})
      `).all(timelineId, ...batch) as NarrativeChunkRow[];
      for (const row of rows) {
        found.set(row.chunk_id, row);
      }
    }
    const result: NarrativeChunkRow[] = [];
    for (const id of new Set(chunkIds)) {
      const row = found.get(id);
      if (row !== undefined) {
        result.push(row);
      }
    }
    return result;
  }
}

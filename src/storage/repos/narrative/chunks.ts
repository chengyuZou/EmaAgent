import type { SqliteDb } from '../../database/database.js';
import { createSqliteIdBatches } from '../../database/sqlite-id-batches.js';

export type NarrativeTimelineId = '1st_Loop' | '2nd_Loop' | '3rd_Loop';

export interface NarrativeChunkVectorRow {
  chunk_id: string;
  timeline_id: NarrativeTimelineId;
  vector: Buffer;
}

export interface NarrativeChunkRow {
  chunk_id: string;
  timeline_id: NarrativeTimelineId;
  content: string;
}

export class NarrativeChunksRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 未传周目时读取全库向量, 用于 mix. naive 传入 Router 返回的所有周目. */
  listVectors(timelineIds?: readonly NarrativeTimelineId[]): NarrativeChunkVectorRow[] {
    if (timelineIds?.length === 0) {
      return [];
    }
    const where = timelineIds === undefined
      ? ''
      : `WHERE timeline_id IN (${timelineIds.map(() => '?').join(', ')})`;
    return this.db.prepare(`
      SELECT chunk_id, timeline_id, vector FROM chunks
      ${where} ORDER BY rowid
    `).all(...(timelineIds ?? [])) as NarrativeChunkVectorRow[];
  }

  /** 图召回已确定候选时只读这些块的向量, 不读正文. 去重后保留输入顺序, 忽略不存在的 ID. */
  findVectorsByIds(chunkIds: readonly string[]): NarrativeChunkVectorRow[] {
    const found = new Map<string, NarrativeChunkVectorRow>();
    for (const batch of createSqliteIdBatches(this.db, chunkIds)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT chunk_id, timeline_id, vector FROM chunks
        WHERE chunk_id IN (${placeholders})
      `).all(...batch) as NarrativeChunkVectorRow[];
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

  /** 只读候选正文. 调用方用本次返回的 Map 按候选 ID 顺序取行. */
  findChunksByIds(chunkIds: readonly string[]): Map<string, NarrativeChunkRow> {
    const found = new Map<string, NarrativeChunkRow>();
    if (chunkIds.length === 0) {
      return found;
    }
    for (const batch of createSqliteIdBatches(this.db, chunkIds)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT chunk_id, timeline_id, content FROM chunks
        WHERE chunk_id IN (${placeholders})
      `).all(...batch) as NarrativeChunkRow[];
      for (const row of rows) {
        found.set(row.chunk_id, row);
      }
    }
    return found;
  }
}

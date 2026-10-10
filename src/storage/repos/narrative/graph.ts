import type { SqliteDb } from '../../database/database.js';
import {
  createSqliteIdBatches,
  SQLITE_ID_BATCH_HARD_LIMIT,
  sqliteVariableLimit,
} from '../../database/sqlite-id-batches.js';
import type { NarrativeTimelineId } from './chunks.js';

export interface NarrativeEntityVectorRow {
  entity_name: string;
  vector: Buffer;
}

export interface NarrativeRelationVectorRow {
  relation_id: number;
  vector: Buffer;
}

export interface NarrativeEntityRow {
  entity_name: string;
  entity_type: string;
  description: string;
}

export interface NarrativeRelationRow {
  relation_id: number;
  source_entity: string;
  target_entity: string;
  description: string;
  weight: number;
}

export class NarrativeGraphRepo {
  constructor(private readonly db: SqliteDb) {}

  listEntityVectors(timelineId: NarrativeTimelineId): NarrativeEntityVectorRow[] {
    return this.db.prepare(`
      SELECT entity_name, vector FROM entities
      WHERE timeline_id = ? ORDER BY rowid
    `).all(timelineId) as NarrativeEntityVectorRow[];
  }

  listRelationVectors(timelineId: NarrativeTimelineId): NarrativeRelationVectorRow[] {
    return this.db.prepare(`
      SELECT relation_id, vector FROM relations
      WHERE timeline_id = ? ORDER BY rowid
    `).all(timelineId) as NarrativeRelationVectorRow[];
  }

  /** 按传入名称的首次出现顺序返回, 忽略不存在的实体; 不读取向量. */
  findEntities(timelineId: NarrativeTimelineId, entityNames: readonly string[]): NarrativeEntityRow[] {
    const found = new Map<string, NarrativeEntityRow>();
    for (const batch of createSqliteIdBatches(this.db, entityNames, { fixedParameterCount: 1 })) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT entity_name, entity_type, description FROM entities
        WHERE timeline_id = ? AND entity_name IN (${placeholders})
      `).all(timelineId, ...batch) as NarrativeEntityRow[];
      for (const row of rows) {
        found.set(row.entity_name, row);
      }
    }
    const result: NarrativeEntityRow[] = [];
    for (const name of new Set(entityNames)) {
      const row = found.get(name);
      if (row !== undefined) {
        result.push(row);
      }
    }
    return result;
  }

  /** 按传入 ID 的首次出现顺序返回, 忽略不存在的关系; 不读取向量. */
  findRelations(timelineId: NarrativeTimelineId, relationIds: readonly number[]): NarrativeRelationRow[] {
    const found = new Map<number, NarrativeRelationRow>();
    for (const batch of this.relationIdBatches(relationIds)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT relation_id, source_entity, target_entity, description, weight FROM relations
        WHERE timeline_id = ? AND relation_id IN (${placeholders})
      `).all(timelineId, ...batch) as NarrativeRelationRow[];
      for (const row of rows) {
        found.set(row.relation_id, row);
      }
    }
    const result: NarrativeRelationRow[] = [];
    for (const id of new Set(relationIds)) {
      const row = found.get(id);
      if (row !== undefined) {
        result.push(row);
      }
    }
    return result;
  }

  /** 按实体分别返回相邻关系, 每组保留资产插入顺序; 自环在该组只出现一次. */
  findIncidentRelations(
    timelineId: NarrativeTimelineId,
    entityNames: readonly string[],
  ): Map<string, NarrativeRelationRow[]> {
    const result = new Map<string, NarrativeRelationRow[]>();
    for (const name of entityNames) {
      if (!result.has(name)) {
        result.set(name, []);
      }
    }
    const batches = createSqliteIdBatches(this.db, entityNames, {
      occurrencesPerId: 2,
      fixedParameterCount: 1,
    });
    for (const batch of batches) {
      const names = new Set(batch);
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT relation_id, source_entity, target_entity, description, weight FROM relations
        WHERE timeline_id = ?
          AND (source_entity IN (${placeholders}) OR target_entity IN (${placeholders}))
        ORDER BY rowid
      `).all(timelineId, ...batch, ...batch) as NarrativeRelationRow[];
      for (const row of rows) {
        if (names.has(row.source_entity)) {
          result.get(row.source_entity)!.push(row);
        }
        if (row.target_entity !== row.source_entity && names.has(row.target_entity)) {
          result.get(row.target_entity)!.push(row);
        }
      }
    }
    return result;
  }

  /** 与 NetworkX 无向图一致: 自环贡献两次连接, 无连接或不存在的实体返回 0. */
  getEntityDegrees(timelineId: NarrativeTimelineId, entityNames: readonly string[]): Map<string, number> {
    const result = new Map<string, number>();
    for (const name of entityNames) {
      result.set(name, 0);
    }
    const batches = createSqliteIdBatches(this.db, entityNames, {
      occurrencesPerId: 2,
      fixedParameterCount: 2,
    });
    for (const batch of batches) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT entity_name, count(*) AS degree FROM (
          SELECT source_entity AS entity_name FROM relations
          WHERE timeline_id = ? AND source_entity IN (${placeholders})
          UNION ALL
          SELECT target_entity AS entity_name FROM relations
          WHERE timeline_id = ? AND target_entity IN (${placeholders})
        ) GROUP BY entity_name
      `).all(timelineId, ...batch, timelineId, ...batch) as Array<{ entity_name: string; degree: number }>;
      for (const row of rows) {
        result.set(row.entity_name, row.degree);
      }
    }
    return result;
  }

  /** 
   * 获得每个实体对应的来源Chunk块 ID 列表, 按插入顺序返回; 并忽略不存在的实体.
   * @returns Map<entity_name, chunk_id[]>
   */
  getEntityChunkIds(timelineId: NarrativeTimelineId, entityNames: readonly string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const name of entityNames) {
      if (!result.has(name)) {
        result.set(name, []);
      }
    }
    for (const batch of createSqliteIdBatches(this.db, entityNames, { fixedParameterCount: 1 })) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT entity_name, chunk_id FROM entity_chunks
        WHERE timeline_id = ? AND entity_name IN (${placeholders}) ORDER BY rowid
      `).all(timelineId, ...batch) as Array<{ entity_name: string; chunk_id: string }>;
      for (const row of rows) {
        result.get(row.entity_name)!.push(row.chunk_id);
      }
    }
    return result;
  }

  /** 每条关系分别保留来源块的资产插入顺序, 不合并不同关系的引用. */
  getRelationChunkIds(timelineId: NarrativeTimelineId, relationIds: readonly number[]): Map<number, string[]> {
    const result = new Map<number, string[]>();
    for (const id of relationIds) {
      if (!result.has(id)) {
        result.set(id, []);
      }
    }
    for (const batch of this.relationIdBatches(relationIds)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT relation_id, chunk_id FROM relation_chunks
        WHERE timeline_id = ? AND relation_id IN (${placeholders}) ORDER BY rowid
      `).all(timelineId, ...batch) as Array<{ relation_id: number; chunk_id: string }>;
      for (const row of rows) {
        result.get(row.relation_id)!.push(row.chunk_id);
      }
    }
    return result;
  }

  private relationIdBatches(relationIds: readonly number[]): number[][] {
    const batchSize = Math.min(SQLITE_ID_BATCH_HARD_LIMIT, sqliteVariableLimit(this.db) - 1);
    const ids = [...new Set(relationIds)];
    const batches: number[][] = [];
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      batches.push(ids.slice(offset, offset + batchSize));
    }
    return batches;
  }
}

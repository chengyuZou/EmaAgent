// 核算全局 Memory 的逻辑载荷，并提供预算治理所需的有界候选与批量变更。

import type { SqliteDb } from '../../database/database.js';
import { createSqliteIdBatches } from '../../database/sqlite-id-batches.js';
import type { MemoryItemKind } from './memory-items.js';
import type { MemoryNodeType } from './memory-nodes.js';

export interface MemoryStorageFootprint {
  totalBytes: number;
  nodesBytes: number;
  edgesBytes: number;
  lazyUpdatesBytes: number;
  nodeSourcesBytes: number;
  itemsBytes: number;
}

export class MemoryStorageRepo {
  constructor(private readonly db: SqliteDb) {}

  /**
   * 这里核算业务载荷，不等同于 SQLite 文件大小。文本按 UTF-8 字节计，
   * BLOB 按真实长度计，数值列按 8 字节计，删除后的空闲页由 SQLite 后续复用。
   */
  logicalFootprint(): MemoryStorageFootprint {
    const row = this.db.prepare(
      `SELECT
         (
           SELECT COALESCE(SUM(
             length(CAST(id AS BLOB))
             + length(CAST(label AS BLOB))
             + length(CAST(node_type AS BLOB))
             + length(CAST(description AS BLOB))
             + COALESCE(length(embedding), 0)
             + COALESCE(length(CAST(embedding_provider_id AS BLOB)), 0)
             + COALESCE(length(CAST(embedding_model AS BLOB)), 0)
             + COALESCE(length(CAST(embedding_normalization AS BLOB)), 0)
             + COALESCE(length(CAST(embedding_revision AS BLOB)), 0)
             + COALESCE(length(CAST(embedding_space_id AS BLOB)), 0)
             + length(CAST(meta_json AS BLOB))
             + 8 * (
               5
               + (embedding_dim IS NOT NULL)
               + (embedding_evicted_at IS NOT NULL)
               + (last_decayed_at IS NOT NULL)
             )
           ), 0)
           FROM memory_nodes
         ) AS nodes_bytes,
         (
           SELECT COALESCE(SUM(
             length(CAST(id AS BLOB))
             + length(CAST(from_node_id AS BLOB))
             + length(CAST(to_node_id AS BLOB))
             + length(CAST(relation AS BLOB))
             + 8 * 3
           ), 0)
           FROM memory_edges
         ) AS edges_bytes,
         (
           SELECT COALESCE(SUM(
             length(CAST(id AS BLOB))
             + length(CAST(node_id AS BLOB))
             + length(CAST(fragment AS BLOB))
             + COALESCE(length(CAST(source_session_id AS BLOB)), 0)
             + COALESCE(length(CAST(source_turn_id AS BLOB)), 0)
             + 8
           ), 0)
           FROM memory_node_lazy_updates
         ) AS lazy_updates_bytes,
         (
           SELECT COALESCE(SUM(
             length(CAST(node_id AS BLOB))
             + length(CAST(source_session_id AS BLOB))
             + length(CAST(source_turn_id AS BLOB))
             + 8
           ), 0)
           FROM memory_node_sources
         ) AS node_sources_bytes,
         (
           SELECT COALESCE(SUM(
             length(CAST(id AS BLOB))
             + length(CAST(kind AS BLOB))
             + length(CAST(title AS BLOB))
             + length(CAST(body AS BLOB))
             + COALESCE(length(embedding), 0)
             + COALESCE(length(CAST(source_session_id AS BLOB)), 0)
             + COALESCE(length(CAST(source_turn_id AS BLOB)), 0)
             + length(CAST(meta_json AS BLOB))
             + length(CAST(profiles_json AS BLOB))
             + COALESCE(length(CAST(embedding_provider_id AS BLOB)), 0)
             + COALESCE(length(CAST(embedding_model AS BLOB)), 0)
             + COALESCE(length(CAST(embedding_normalization AS BLOB)), 0)
             + COALESCE(length(CAST(embedding_revision AS BLOB)), 0)
             + COALESCE(length(CAST(embedding_space_id AS BLOB)), 0)
             + 8 * (
               5
               + (expires_at IS NOT NULL)
               + (embedding_dim IS NOT NULL)
               + (embedding_evicted_at IS NOT NULL)
               + (last_decayed_at IS NOT NULL)
             )
           ), 0)
           FROM memory_items
         ) AS items_bytes`,
    ).get() as {
      nodes_bytes: number;
      edges_bytes: number;
      lazy_updates_bytes: number;
      node_sources_bytes: number;
      items_bytes: number;
    };

    const footprint = {
      nodesBytes: row.nodes_bytes,
      edgesBytes: row.edges_bytes,
      lazyUpdatesBytes: row.lazy_updates_bytes,
      nodeSourcesBytes: row.node_sources_bytes,
      itemsBytes: row.items_bytes,
    };
    return {
      ...footprint,
      totalBytes: Object.values(footprint).reduce((sum, bytes) => sum + bytes, 0),
    };
  }

  listExpiredItemIds(nowMs: number, limit: number): string[] {
    return this.db.prepare(
      `SELECT id
         FROM memory_items
        WHERE expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at ASC, id ASC
        LIMIT ?`,
    ).all(nowMs, limit).map(row => (row as { id: string }).id);
  }

  listColdZeroImportanceNodeIds(
    cutoff: number,
    protectedTypes: readonly MemoryNodeType[],
    limit: number,
  ): string[] {
    const exclusion = placeholders(protectedTypes.length);
    return this.db.prepare(
      `SELECT id
         FROM memory_nodes
        WHERE importance = 0
          AND last_referenced_at < ?
          ${exclusion ? `AND node_type NOT IN (${exclusion})` : ''}
        ORDER BY last_referenced_at ASC, id ASC
        LIMIT ?`,
    ).all(cutoff, ...protectedTypes, limit).map(row => (row as { id: string }).id);
  }

  listColdZeroImportanceItemIds(
    cutoff: number,
    protectedKinds: readonly MemoryItemKind[],
    limit: number,
  ): string[] {
    const exclusion = placeholders(protectedKinds.length);
    return this.db.prepare(
      `SELECT id
         FROM memory_items
        WHERE importance = 0
          AND last_referenced_at < ?
          ${exclusion ? `AND kind NOT IN (${exclusion})` : ''}
        ORDER BY last_referenced_at ASC, id ASC
        LIMIT ?`,
    ).all(cutoff, ...protectedKinds, limit).map(row => (row as { id: string }).id);
  }

  listColdEmbeddedNodeIds(
    cutoff: number,
    protectedTypes: readonly MemoryNodeType[],
    limit: number,
  ): string[] {
    const exclusion = placeholders(protectedTypes.length);
    return this.db.prepare(
      `SELECT id
         FROM memory_nodes
        WHERE embedding IS NOT NULL
          AND last_referenced_at < ?
          ${exclusion ? `AND node_type NOT IN (${exclusion})` : ''}
        ORDER BY last_referenced_at ASC, importance ASC, id ASC
        LIMIT ?`,
    ).all(cutoff, ...protectedTypes, limit).map(row => (row as { id: string }).id);
  }

  listColdEmbeddedItemIds(
    nowMs: number,
    cutoff: number,
    protectedKinds: readonly MemoryItemKind[],
    limit: number,
  ): string[] {
    const exclusion = placeholders(protectedKinds.length);
    return this.db.prepare(
      `SELECT id
         FROM memory_items
        WHERE embedding IS NOT NULL
          AND (expires_at IS NULL OR expires_at > ?)
          AND last_referenced_at < ?
          ${exclusion ? `AND kind NOT IN (${exclusion})` : ''}
        ORDER BY last_referenced_at ASC, importance ASC, id ASC
        LIMIT ?`,
    ).all(nowMs, cutoff, ...protectedKinds, limit).map(row => (row as { id: string }).id);
  }

  deleteNodes(ids: readonly string[]): number {
    return this.deleteByIds('memory_nodes', ids);
  }

  deleteItems(ids: readonly string[]): number {
    return this.deleteByIds('memory_items', ids);
  }

  evictNodeEmbeddings(ids: readonly string[], evictedAt: number): number {
    return this.evictEmbeddings('memory_nodes', ids, evictedAt);
  }

  evictItemEmbeddings(ids: readonly string[], evictedAt: number): number {
    return this.evictEmbeddings('memory_items', ids, evictedAt);
  }

  private deleteByIds(table: 'memory_nodes' | 'memory_items', ids: readonly string[]): number {
    const batches = createSqliteIdBatches(this.db, [...ids]);
    let deleted = 0;
    for (const batch of batches) {
      const marks = placeholders(batch.length);
      deleted += this.db.prepare(`DELETE FROM ${table} WHERE id IN (${marks})`).run(...batch).changes;
    }
    return deleted;
  }

  private evictEmbeddings(
    table: 'memory_nodes' | 'memory_items',
    ids: readonly string[],
    evictedAt: number,
  ): number {
    const batches = createSqliteIdBatches(this.db, [...ids], { fixedParameterCount: 1 });
    let evicted = 0;
    for (const batch of batches) {
      const marks = placeholders(batch.length);
      evicted += this.db.prepare(
        `UPDATE ${table}
            SET embedding = NULL,
                embedding_evicted_at = ?
          WHERE embedding IS NOT NULL AND id IN (${marks})`,
      ).run(evictedAt, ...batch).changes;
    }
    return evicted;
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

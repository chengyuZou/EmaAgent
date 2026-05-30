import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type MemoryNodeType =
  | 'user_fact' | 'entity' | 'event'
  | 'emotion'   | 'preference' | 'relationship';

export interface MemoryNodeRow {
  id:                     string;
  label:                  string;
  node_type:              MemoryNodeType;
  description:            string;
  embedding:              Buffer | null;
  embedding_provider_id:  string | null;
  embedding_model:        string | null;
  embedding_dim:          number | null;
  importance:             number;
  created_at:             number;
  updated_at:             number;
  last_referenced_at:     number;
  meta_json:              string;
}

export interface MemoryNodeInsert {
  id:                    string;
  label:                 string;
  nodeType:              MemoryNodeType;
  description:           string;
  embedding?:            Buffer;
  embeddingProviderId?:  string;
  embeddingModel?:       string;
  embeddingDim?:         number;
  importance?:           number;
  createdAt:             number;
}

export interface MemoryNodeDescriptionUpdate {
  id:                    string;
  description:           string;
  importanceDelta?:      number;
  updatedAt:             number;
}

export interface MemoryNodeEmbeddingUpdate {
  id:                    string;
  embedding:             Buffer;
  embeddingProviderId:   string;
  embeddingModel:        string;
  embeddingDim:          number;
  updatedAt:             number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Layer-0 entity graph nodes — cross-session, shared across all modes.
 *
 * Concurrency: relies on the UNIQUE(label, node_type) index so concurrent
 * extraction runs can use INSERT ... ON CONFLICT to coalesce duplicates
 * without explicit locking.
 */
export class MemoryNodesRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── Insert / upsert ─────────────────────────────────────────────────────────

  insert(n: MemoryNodeInsert): void {
    this.db
      .prepare(
        `INSERT INTO memory_nodes
           (id, label, node_type, description, embedding,
            embedding_provider_id, embedding_model, embedding_dim,
            importance, created_at, updated_at, last_referenced_at, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
      )
      .run(
        n.id, n.label, n.nodeType, n.description,
        n.embedding ?? null,
        n.embeddingProviderId ?? null,
        n.embeddingModel       ?? null,
        n.embeddingDim         ?? null,
        n.importance ?? 50,
        n.createdAt, n.createdAt, n.createdAt,
      );
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  findById(id: string): MemoryNodeRow | undefined {
    return this.db
      .prepare('SELECT * FROM memory_nodes WHERE id = ?')
      .get(id) as MemoryNodeRow | undefined;
  }

  findByLabelAndType(label: string, nodeType: MemoryNodeType): MemoryNodeRow | undefined {
    return this.db
      .prepare('SELECT * FROM memory_nodes WHERE label = ? AND node_type = ?')
      .get(label, nodeType) as MemoryNodeRow | undefined;
  }

  listAll(limit = 5000): MemoryNodeRow[] {
    return this.db
      .prepare('SELECT * FROM memory_nodes ORDER BY last_referenced_at DESC LIMIT ?')
      .all(limit) as MemoryNodeRow[];
  }

  listByType(nodeType: MemoryNodeType, limit = 500): MemoryNodeRow[] {
    return this.db
      .prepare('SELECT * FROM memory_nodes WHERE node_type = ? ORDER BY importance DESC LIMIT ?')
      .all(nodeType, limit) as MemoryNodeRow[];
  }

  /** Nodes embedded with the given model — dim guard is done in the capability layer. */
  listEmbeddable(model: string, limit = 5000): MemoryNodeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_nodes
         WHERE embedding IS NOT NULL AND embedding_model = ?
         LIMIT ?`,
      )
      .all(model, limit) as MemoryNodeRow[];
  }

  /**
   * Cursor page for bulk index building.
   * Returns rows with updated_at > afterUpdatedAt, ordered ascending, up to limit.
   * Start with afterUpdatedAt = 0; advance cursor to last row's updated_at each page.
   */
  listEmbeddablePage(model: string, afterUpdatedAt: number, limit: number): MemoryNodeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_nodes
         WHERE embedding IS NOT NULL AND embedding_model = ? AND updated_at > ?
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(model, afterUpdatedAt, limit) as MemoryNodeRow[];
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  /** Used by consolidation LLM after draining lazy_updates. */
  updateDescription(u: MemoryNodeDescriptionUpdate): void {
    this.db
      .prepare(
        `UPDATE memory_nodes
            SET description = ?,
                importance  = MAX(0, MIN(100, importance + ?)),
                updated_at  = ?
          WHERE id = ?`,
      )
      .run(u.description, u.importanceDelta ?? 0, u.updatedAt, u.id);
  }

  updateEmbedding(u: MemoryNodeEmbeddingUpdate): void {
    this.db
      .prepare(
        `UPDATE memory_nodes
            SET embedding             = ?,
                embedding_provider_id = ?,
                embedding_model       = ?,
                embedding_dim         = ?,
                updated_at            = ?
          WHERE id = ?`,
      )
      .run(u.embedding, u.embeddingProviderId, u.embeddingModel, u.embeddingDim, u.updatedAt, u.id);
  }

  touchReferenced(ids: string[], at: number): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(`UPDATE memory_nodes SET last_referenced_at = ? WHERE id IN (${placeholders})`)
      .run(at, ...ids);
  }

  // ── Counts (startup recovery + diagnostics) ─────────────────────────────────

  countStaleEmbeddings(currentProviderId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_nodes
         WHERE embedding IS NOT NULL AND embedding_provider_id != ?`,
      )
      .get(currentProviderId) as { n: number };
    return row.n;
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  delete(id: string): void {
    this.db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(id);
  }
}

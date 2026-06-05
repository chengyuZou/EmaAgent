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

export interface MemoryImportanceUpdate {
  id: string;
  importance: number;
  updatedAt: number;
}

export interface MemoryReferenceBoostOptions {
  maxBoost: number;
  halfLifeDays: number;
  saturationStart: number;
  saturationSlope: number;
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

  listDecayCandidates(cutoff: number, limit = 5000): Array<{
    id: string;
    label: string;
    node_type: MemoryNodeType;
    importance: number;
  }> {
    return this.db
      .prepare(
        `SELECT id, label, node_type, importance
           FROM memory_nodes
          WHERE last_referenced_at < ? AND importance > 0
          ORDER BY last_referenced_at ASC
          LIMIT ?`,
      )
      .all(cutoff, limit) as Array<{
        id: string;
        label: string;
        node_type: MemoryNodeType;
        importance: number;
      }>;
  }

  applyImportanceUpdates(updates: MemoryImportanceUpdate[]): void {
    if (updates.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE memory_nodes
          SET importance = MAX(0, MIN(100, ?)),
              updated_at = ?
        WHERE id = ?`,
    );
    const txn = this.db.transaction(() => {
      for (const u of updates) stmt.run(u.importance, u.updatedAt, u.id);
    });
    txn();
  }

  touchReferenced(
    ids: string[],
    at: number,
    boost?: MemoryReferenceBoostOptions,
  ): void {
    if (ids.length === 0) return;
    const uniq = [...new Set(ids)];
    const placeholders = uniq.map(() => '?').join(',');

    if (!boost) {
      this.db
        .prepare(`UPDATE memory_nodes SET last_referenced_at = ? WHERE id IN (${placeholders})`)
        .run(at, ...uniq);
      return;
    }

    const rows = this.db
      .prepare(
        `SELECT id, importance, last_referenced_at
           FROM memory_nodes
          WHERE id IN (${placeholders})`,
      )
      .all(...uniq) as Array<{ id: string; importance: number; last_referenced_at: number }>;

    const stmt = this.db.prepare(
      `UPDATE memory_nodes
          SET importance = ?,
              last_referenced_at = ?,
              updated_at = ?
        WHERE id = ?`,
    );

    const txn = this.db.transaction(() => {
      for (const row of rows) {
        const next = boostedImportance(row.importance, row.last_referenced_at, at, boost);
        stmt.run(next, at, at, row.id);
      }
    });
    txn();
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

function boostedImportance(
  current: number,
  lastReferencedAt: number,
  now: number,
  opts: MemoryReferenceBoostOptions,
): number {
  const ageDays = Math.max(0, (now - lastReferencedAt) / 86_400_000);
  const staleFactor = 1 / (1 + Math.exp(-(ageDays - opts.halfLifeDays) / Math.max(1, opts.halfLifeDays / 3)));
  const saturation = 1 / (1 + Math.exp((current - opts.saturationStart) / Math.max(1, opts.saturationSlope)));
  const boost = opts.maxBoost * staleFactor * saturation;
  return Math.max(0, Math.min(100, Math.round(current + boost)));
}
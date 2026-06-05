import type { SqliteDb } from '../database.js';
import type { SessionId, TurnId } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type MemoryItemKind = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryItemRow {
  id:                     string;
  kind:                   MemoryItemKind;
  title:                  string;
  body:                   string;
  embedding:              Buffer | null;
  source_session_id:      string | null;
  source_turn_id:         string | null;
  created_at:             number;
  updated_at:             number;
  expires_at:             number | null;
  importance:             number;
  meta_json:              string;
  modes_json:             string;
  last_referenced_at:     number;
  embedding_provider_id:  string | null;
  embedding_model:        string | null;
  embedding_dim:          number | null;
}

export interface MemoryItemInsert {
  id:                  string;
  kind:                MemoryItemKind;
  title:               string;
  body:                string;
  modes:               string[];                  // serialised into modes_json
  embedding?:          Buffer;
  embeddingProviderId?: string;
  embeddingModel?:     string;
  embeddingDim?:       number;
  sourceSessionId?:    SessionId;
  sourceTurnId?:       TurnId;
  importance?:         number;
  expiresAt?:          number;
  createdAt:           number;
}

export interface MemoryItemEmbeddingUpdate {
  id:                  string;
  embedding:           Buffer;
  embeddingProviderId: string;
  embeddingModel:      string;
  embeddingDim:        number;
  updatedAt:           number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Layer-2 episodic memory + Agent long-term memory (4 kinds).
 *
 * `modes` controls which conversation modes recall this item:
 *   ["chat"]              — only surfaced in chat mode
 *   ["agent"]             — only surfaced in agent mode
 *   ["chat","agent"]      — surfaced in both (default for items extracted from
 *                           cross-cutting facts)
 * Mode filtering is a soft weighting in the planner — the repo just stores
 * the tag and exposes a listByMode for the cheap path.
 */
export class MemoryItemsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── Insert ──────────────────────────────────────────────────────────────────

  insert(m: MemoryItemInsert): void {
    this.db
      .prepare(
        `INSERT INTO memory_items
           (id, kind, title, body, embedding,
            source_session_id, source_turn_id,
            created_at, updated_at, expires_at,
            importance, meta_json,
            modes_json, last_referenced_at,
            embedding_provider_id, embedding_model, embedding_dim)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id, m.kind, m.title, m.body,
        m.embedding ?? null,
        m.sourceSessionId ?? null, m.sourceTurnId ?? null,
        m.createdAt, m.createdAt, m.expiresAt ?? null,
        m.importance ?? 50,
        JSON.stringify(m.modes),
        m.createdAt,
        m.embeddingProviderId ?? null,
        m.embeddingModel       ?? null,
        m.embeddingDim         ?? null,
      );
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  findById(id: string): MemoryItemRow | undefined {
    return this.db
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get(id) as MemoryItemRow | undefined;
  }

  /** Idempotency check: same session + same title = same item. Used to skip
   *  duplicate inserts when the extraction pipeline retries. */
  findBySourceAndTitle(sourceSessionId: string, title: string): MemoryItemRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM memory_items
          WHERE source_session_id = ? AND title = ?
          LIMIT 1`,
      )
      .get(sourceSessionId, title) as MemoryItemRow | undefined;
  }

  listByKind(kind: MemoryItemKind, limit = 500): MemoryItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_items
          WHERE kind = ? AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY importance DESC, updated_at DESC
          LIMIT ?`,
      )
      .all(kind, Date.now(), limit) as MemoryItemRow[];
  }

  /**
   * List items whose modes_json array contains the given mode tag.
   * Uses JSON1 — every SQLite build we ship has it (better-sqlite3 default).
   */
  listByMode(mode: string, limit = 500): MemoryItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_items
          WHERE EXISTS (
            SELECT 1 FROM json_each(memory_items.modes_json)
             WHERE json_each.value = ?
          ) AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY importance DESC, updated_at DESC
          LIMIT ?`,
      )
      .all(mode, Date.now(), limit) as MemoryItemRow[];
  }

  /** Non-expired items embedded with the given model — dim guard is done in the capability layer. */
  listEmbeddable(model: string, limit = 5000): MemoryItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_items
          WHERE embedding IS NOT NULL AND embedding_model = ?
            AND (expires_at IS NULL OR expires_at > ?)
          LIMIT ?`,
      )
      .all(model, Date.now(), limit) as MemoryItemRow[];
  }

  /**
   * Cursor page for bulk index building.
   * Returns non-expired rows with updated_at > afterUpdatedAt, ordered ascending, up to limit.
   * Start with afterUpdatedAt = 0; advance cursor to last row's updated_at each page.
   */
  listEmbeddablePage(model: string, afterUpdatedAt: number, limit: number): MemoryItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_items
          WHERE embedding IS NOT NULL AND embedding_model = ? AND updated_at > ?
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY updated_at ASC
          LIMIT ?`,
      )
      .all(model, afterUpdatedAt, Date.now(), limit) as MemoryItemRow[];
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  updateEmbedding(u: MemoryItemEmbeddingUpdate): void {
    this.db
      .prepare(
        `UPDATE memory_items
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
      .prepare(`UPDATE memory_items SET last_referenced_at = ? WHERE id IN (${placeholders})`)
      .run(at, ...ids);
  }

  // ── Counts / startup diagnostics ────────────────────────────────────────────

  countStaleEmbeddings(currentProviderId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_items
         WHERE embedding IS NOT NULL AND embedding_provider_id != ?`,
      )
      .get(currentProviderId) as { n: number };
    return row.n;
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  delete(id: string): void {
    this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(id);
  }

  /** Sweep expired rows. Run periodically as a maintenance task. */
  deleteExpired(now: number): number {
    const info = this.db
      .prepare('DELETE FROM memory_items WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(now);
    return info.changes;
  }
}

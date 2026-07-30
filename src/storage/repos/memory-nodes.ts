import type { SqliteDb } from '../database.js';
import { createSqliteIdBatches } from '../sqlite-id-batches.js';
import { escapeLikePattern } from '../like-utils.js';
import type { MemoryEmbeddingPageCursor } from './memory-embedding-page.js';

// ── 类型 ─────────────────────────────────────────────────────────────────────

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
  embedding_normalization: string | null;
  embedding_revision:      string | null;
  embedding_space_id:      string | null;
  embedding_evicted_at:    number | null;
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
  embeddingNormalization?: string;
  embeddingRevision?:    string;
  embeddingSpaceId?:     string;
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
  embeddingNormalization: string;
  embeddingRevision:     string;
  embeddingSpaceId:      string;
  updatedAt:             number;
}

export interface MemoryNodeEmbeddingRepair extends MemoryNodeEmbeddingUpdate {
  /** 扫描时看到的版本；内容或向量已被其他任务更新时拒绝覆盖。 */
  expectedUpdatedAt: number;
  /** 本轮计划修复到的空间；已经被并发任务修好时无需再次写入。 */
  targetSpaceId: string;
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

export interface MemoryNodeStatsRow {
  node_type: MemoryNodeType;
  total: number;
  avg_importance: number | null;
  oldest_ref_at: number | null;
  newest_ref_at: number | null;
  embedded_count: number;
}

export interface MemoryNodesBrowseOptions {
  limit?: number;
  nodeType?: MemoryNodeType;
  minImportance?: number;
  orderBy?: 'lastRef' | 'importance' | 'created';
  search?: string;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Layer-0 实体图节点-跨 session，所有 mode 共享。
 *
 * 并发：依赖 UNIQUE(label, node_type) 索引，使并发 extraction
 * 可用 INSERT ... ON CONFLICT 合并重复项，无需显式锁。
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
            embedding_normalization, embedding_revision, embedding_space_id,
            importance, created_at, updated_at, last_referenced_at, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
      )
      .run(
        n.id, n.label, n.nodeType, n.description,
        n.embedding ?? null,
        n.embeddingProviderId ?? null,
        n.embeddingModel       ?? null,
        n.embeddingDim         ?? null,
        n.embeddingNormalization ?? null,
        n.embeddingRevision    ?? null,
        n.embeddingSpaceId     ?? null,
        n.importance ?? 50,
        n.createdAt, n.createdAt, n.createdAt,
      );
  }

  // ── 读取 ────────────────────────────────────────────────────────────────────

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
      .prepare('SELECT * FROM memory_nodes ORDER BY last_referenced_at DESC, id DESC LIMIT ?')
      .all(limit) as MemoryNodeRow[];
  }

  listByType(nodeType: MemoryNodeType, limit = 500): MemoryNodeRow[] {
    return this.db
      .prepare('SELECT * FROM memory_nodes WHERE node_type = ? ORDER BY importance DESC, id DESC LIMIT ?')
      .all(nodeType, limit) as MemoryNodeRow[];
  }

  /** 只读取指定向量空间的节点；旧版 NULL 空间不会参与召回。 */
  listEmbeddable(spaceId: string, limit = 5000): MemoryNodeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_nodes
         WHERE embedding IS NOT NULL AND embedding_space_id = ?
         LIMIT ?`,
      )
      .all(spaceId, limit) as MemoryNodeRow[];
  }

  /**
   * 用于批量构建索引的复合游标分页。
   * 按 (updated_at, id) 升序读取，避免同毫秒数据跨页丢失。
   */
  listEmbeddablePage(
    spaceId: string,
    after: MemoryEmbeddingPageCursor | undefined,
    limit: number,
  ): MemoryNodeRow[] {
    const cursorPredicate = after
      ? 'AND (updated_at > ? OR (updated_at = ? AND id > ?))'
      : '';
    const params = after
      ? [spaceId, after.updatedAt, after.updatedAt, after.id, limit]
      : [spaceId, limit];

    return this.db.prepare(
      `SELECT * FROM memory_nodes
       WHERE embedding IS NOT NULL AND embedding_space_id = ?
       ${cursorPredicate}
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`,
    ).all(...params) as MemoryNodeRow[];
  }

  browse(opts: MemoryNodesBrowseOptions = {}): MemoryNodeRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (opts.nodeType) {
      where.push('node_type = ?');
      params.push(opts.nodeType);
    }
    if (typeof opts.minImportance === 'number') {
      where.push('importance >= ?');
      params.push(opts.minImportance);
    }
    if (opts.search) {
      where.push(`(label LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`);
      const pattern = '%' + escapeLikePattern(opts.search) + '%';
      params.push(pattern, pattern);
    }

    const orderBy = opts.orderBy === 'importance' ? 'importance DESC, id DESC'
                  : opts.orderBy === 'created'    ? 'created_at DESC, id DESC'
                  :                                  'last_referenced_at DESC, id DESC';
    const sql =
      `SELECT * FROM memory_nodes` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY ${orderBy} LIMIT ?`;
    params.push(opts.limit ?? 100);

    return this.db.prepare(sql).all(...params) as MemoryNodeRow[];
  }

  // ── 更新 ──────────────────────────────────────────────────────────────────

  /** consolidation LLM 在消费完 lazy_updates 后使用。 */
  updateDescription(u: MemoryNodeDescriptionUpdate): void {
    this.db
      .prepare(
        `UPDATE memory_nodes
            SET description = ?,
                importance  = MAX(0, MIN(100, importance + ?)),
                embedding_evicted_at = NULL,
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
                embedding_normalization = ?,
                embedding_revision    = ?,
                embedding_space_id    = ?,
                embedding_evicted_at  = NULL,
                updated_at            = ?
          WHERE id = ?`,
      )
      .run(
        u.embedding, u.embeddingProviderId, u.embeddingModel, u.embeddingDim,
        u.embeddingNormalization, u.embeddingRevision, u.embeddingSpaceId,
        u.updatedAt, u.id,
      );
  }

  /**
   * 只修复扫描后没有发生变化的 stale 行。
   * Embedding 请求在事务外运行，这个 CAS 防止旧文本生成的向量覆盖并发更新。
   */
  repairEmbeddingIfUnchanged(u: MemoryNodeEmbeddingRepair): boolean {
    const info = this.db
      .prepare(
        `UPDATE memory_nodes
            SET embedding               = ?,
                embedding_provider_id   = ?,
                embedding_model         = ?,
                embedding_dim           = ?,
                embedding_normalization = ?,
                embedding_revision      = ?,
                embedding_space_id      = ?,
                embedding_evicted_at    = NULL,
                updated_at              = ?
          WHERE id = ?
            AND updated_at = ?
            AND embedding_evicted_at IS NULL
            AND (embedding IS NULL OR embedding_space_id IS NOT ?)`,
      )
      .run(
        u.embedding, u.embeddingProviderId, u.embeddingModel, u.embeddingDim,
        u.embeddingNormalization, u.embeddingRevision, u.embeddingSpaceId,
        u.updatedAt, u.id, u.expectedUpdatedAt, u.targetSpaceId,
      );
    return info.changes === 1;
  }

  listDecayCandidates(
    cutoff: number,
    protectedTypes: readonly MemoryNodeType[] = [],
    limit = 5000,
  ): Array<{
    id: string;
    label: string;
    node_type: MemoryNodeType;
    importance: number;
  }> {
    const exclusion = protectedTypes.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT id, label, node_type, importance
           FROM memory_nodes
          WHERE last_referenced_at < ? AND importance > 0
            ${exclusion ? `AND node_type NOT IN (${exclusion})` : ''}
          ORDER BY last_referenced_at ASC, id ASC
          LIMIT ?`,
      )
      .all(cutoff, ...protectedTypes, limit) as Array<{
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
    const batches = createSqliteIdBatches(this.db, ids, {
      fixedParameterCount: boost ? 0 : 1,
    });
    if (batches.length === 0) return;

    if (!boost) {
      this.db.transaction(() => {
        for (const batch of batches) {
          const placeholders = batch.map(() => '?').join(',');
          this.db
            .prepare(
              `UPDATE memory_nodes
                  SET last_referenced_at = ?,
                      embedding_evicted_at = NULL
                WHERE id IN (${placeholders})`,
            )
            .run(at, ...batch);
        }
      })();
      return;
    }

    const stmt = this.db.prepare(
      `UPDATE memory_nodes
          SET importance = ?,
              last_referenced_at = ?,
              embedding_evicted_at = NULL,
              updated_at = ?
        WHERE id = ?`,
    );

    const txn = this.db.transaction(() => {
      const rows: Array<{ id: string; importance: number; last_referenced_at: number }> = [];
      for (const batch of batches) {
        const placeholders = batch.map(() => '?').join(',');
        rows.push(...this.db
          .prepare(
            `SELECT id, importance, last_referenced_at
               FROM memory_nodes
              WHERE id IN (${placeholders})`,
          )
          .all(...batch) as Array<{ id: string; importance: number; last_referenced_at: number }>);
      }
      for (const row of rows) {
        const next = boostedImportance(row.importance, row.last_referenced_at, at, boost);
        stmt.run(next, at, at, row.id);
      }
    });
    txn();
  }

  // ── 计数（启动恢复 + 诊断） ─────────────────────────────────

  countStaleEmbeddings(currentSpaceId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_nodes
         WHERE embedding IS NOT NULL AND embedding_space_id IS NOT ?`,
      )
      .get(currentSpaceId) as { n: number };
    return row.n;
  }

  /**
   * 待修复向量行（异空间或从未嵌入），按 (updated_at, id) 升序。
   * 修复成功的行自动离开结果集，分页进度隐式推进，无需游标持久化。
   */
  listStaleEmbeddingPage(currentSpaceId: string, limit: number): MemoryNodeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_nodes
         WHERE embedding_evicted_at IS NULL
           AND (embedding IS NULL OR embedding_space_id IS NOT ?)
         ORDER BY updated_at ASC, id ASC
         LIMIT ?`,
      )
      .all(currentSpaceId, limit) as MemoryNodeRow[];
  }

  /** 与 listStaleEmbeddingPage 同口径的计数，用于修复扫描报告剩余量。 */
  countRepairableEmbeddings(currentSpaceId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_nodes
         WHERE embedding_evicted_at IS NULL
           AND (embedding IS NULL OR embedding_space_id IS NOT ?)`,
      )
      .get(currentSpaceId) as { n: number };
    return row.n;
  }

  statsByType(): MemoryNodeStatsRow[] {
    return this.db
      .prepare(
        `SELECT node_type,
                COUNT(*) AS total,
                AVG(importance) AS avg_importance,
                MIN(last_referenced_at) AS oldest_ref_at,
                MAX(last_referenced_at) AS newest_ref_at,
                SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded_count
           FROM memory_nodes
          GROUP BY node_type`,
      )
      .all() as MemoryNodeStatsRow[];
  }

  // ── 删除 ──────────────────────────────────────────────────────────────────

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

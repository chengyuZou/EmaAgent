import type { SqliteDb } from '../../database/database.js';
import { createSqliteIdBatches } from '../../database/sqlite-id-batches.js';
import { escapeLikePattern } from '../../search/like-utils.js';
import type { MemoryEmbeddingPageCursor } from './memory-embedding-page.js';
import type { ExecutionProfile } from '@ema-agent/turn';

// ── 类型 ─────────────────────────────────────────────────────────────────────

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
  profiles_json:          string;
  last_referenced_at:     number;
  last_decayed_at:        number | null;
  embedding_provider_id:  string | null;
  embedding_model:        string | null;
  embedding_dim:          number | null;
  embedding_normalization: string | null;
  embedding_revision:      string | null;
  embedding_space_id:      string | null;
  embedding_evicted_at:    number | null;
}

export interface MemoryItemInsert {
  id:                  string;
  kind:                MemoryItemKind;
  title:               string;
  body:                string;
  profiles:           ExecutionProfile[];
  embedding?:          Buffer;
  embeddingProviderId?: string;
  embeddingModel?:     string;
  embeddingDim?:       number;
  embeddingNormalization?: string;
  embeddingRevision?:  string;
  embeddingSpaceId?:   string;
  sourceSessionId?:    string;
  sourceTurnId?:       string;
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
  embeddingNormalization: string;
  embeddingRevision:   string;
  embeddingSpaceId:    string;
  updatedAt:           number;
}

export interface MemoryItemEmbeddingRepair extends MemoryItemEmbeddingUpdate {
  /** 扫描时看到的版本；内容或向量已被其他任务更新时拒绝覆盖。 */
  expectedUpdatedAt: number;
  /** 本轮计划修复到的空间；已经被并发任务修好时无需再次写入。 */
  targetSpaceId: string;
  /** 事务提交时重新确认未过期，避免为刚过期的数据消耗写锁。 */
  repairAt: number;
}

export interface MemoryItemDecayUpdate {
  id: string;
  importance: number;
  expectedImportance: number;
  expectedLastReferencedAt: number;
  expectedLastDecayedAt: number | null;
  updatedAt: number;
}

export interface MemoryReferenceBoostOptions {
  maxBoost: number;
  halfLifeDays: number;
  saturationStart: number;
  saturationSlope: number;
}

export interface MemoryItemStatsRow {
  kind: MemoryItemKind;
  total: number;
  avg_importance: number | null;
  embedded_count: number;
}

export interface MemoryItemsBrowseOptions {
  limit?: number;
  kind?: MemoryItemKind;
  executionProfile?: ExecutionProfile;
  minImportance?: number;
  orderBy?: 'lastRef' | 'importance' | 'created';
  search?: string;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Layer-2 情景记忆 + Agent 长期记忆（4 种 kind）。
 *
 * `profiles` 控制 Chat/Work 中召回 item 的权重。Narrative 是独立 RAG，
 * 不参与这里的分类。Repo 只保存标签，软加权由 Memory Planner 决定。
 */
export class MemoryItemsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── 插入 ──────────────────────────────────────────────────────────────────

  insert(m: MemoryItemInsert): void {
    this.db
      .prepare(
        `INSERT INTO memory_items
           (id, kind, title, body, embedding,
            source_session_id, source_turn_id,
            created_at, updated_at, expires_at,
            importance, meta_json,
            profiles_json, last_referenced_at,
            embedding_provider_id, embedding_model, embedding_dim,
            embedding_normalization, embedding_revision, embedding_space_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id, m.kind, m.title, m.body,
        m.embedding ?? null,
        m.sourceSessionId ?? null, m.sourceTurnId ?? null,
        m.createdAt, m.createdAt, m.expiresAt ?? null,
        m.importance ?? 50,
        JSON.stringify(m.profiles),
        m.createdAt,
        m.embeddingProviderId ?? null,
        m.embeddingModel       ?? null,
        m.embeddingDim         ?? null,
        m.embeddingNormalization ?? null,
        m.embeddingRevision    ?? null,
        m.embeddingSpaceId     ?? null,
      );
  }

  // ── 读取 ────────────────────────────────────────────────────────────────────

  findById(id: string): MemoryItemRow | undefined {
    return this.db
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get(id) as MemoryItemRow | undefined;
  }

  /** 幂等校验：同一 session + 同一 title = 同一 item。用于在 extraction
   *  pipeline 重试时跳过重复插入。 */
  findBySourceAndTitle(sourceSessionId: string, title: string): MemoryItemRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM memory_items
          WHERE source_session_id = ? AND title = ?
          LIMIT 1`,
      )
      .get(sourceSessionId, title) as MemoryItemRow | undefined;
  }

  /** 返回仍被 L2 来源字段引用的 Session，供跨库孤儿恢复扫描。 */
  listSourceSessionIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT source_session_id
           FROM memory_items
          WHERE source_session_id IS NOT NULL
          ORDER BY source_session_id ASC`,
      )
      .all() as Array<{ source_session_id: string }>;
    return rows.map(row => row.source_session_id);
  }

  /** 保留长期记忆正文，只清空已经失效的 Session/Turn 来源。 */
  detachSourceSession(sourceSessionId: string): number {
    return this.db
      .prepare(
        `UPDATE memory_items
            SET source_session_id = NULL,
                source_turn_id = NULL
          WHERE source_session_id = ?`,
      )
      .run(sourceSessionId).changes;
  }

  listByKind(kind: MemoryItemKind, limit = 500): MemoryItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_items
          WHERE kind = ? AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY importance DESC, updated_at DESC, id DESC
          LIMIT ?`,
      )
      .all(kind, Date.now(), limit) as MemoryItemRow[];
  }

  /**
   * 列出 profiles_json 数组中包含给定执行 Profile 的 item。
   * 使用 JSON1-我们打包的每个 SQLite 构建都有（better-sqlite3 默认）。
   */
  listByProfile(executionProfile: ExecutionProfile, limit = 500): MemoryItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_items
          WHERE EXISTS (
            SELECT 1 FROM json_each(memory_items.profiles_json)
             WHERE json_each.value = ?
          ) AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY importance DESC, updated_at DESC, id DESC
          LIMIT ?`,
      )
      .all(executionProfile, Date.now(), limit) as MemoryItemRow[];
  }

  /** 只读取指定向量空间的非过期 item；旧版 NULL 空间不会参与召回。 */
  listEmbeddable(spaceId: string, limit = 5000): MemoryItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_items
          WHERE embedding IS NOT NULL AND embedding_space_id = ?
            AND (expires_at IS NULL OR expires_at > ?)
          LIMIT ?`,
      )
      .all(spaceId, Date.now(), limit) as MemoryItemRow[];
  }

  /**
   * 用于批量构建索引的复合游标分页。
   * 按 (updated_at, id) 升序读取非过期行，避免同毫秒数据跨页丢失。
   */
  listEmbeddablePage(
    spaceId: string,
    after: MemoryEmbeddingPageCursor | undefined,
    limit: number,
  ): MemoryItemRow[] {
    const cursorPredicate = after
      ? 'AND (updated_at > ? OR (updated_at = ? AND id > ?))'
      : '';
    const now = Date.now();
    const params = after
      ? [spaceId, after.updatedAt, after.updatedAt, after.id, now, limit]
      : [spaceId, now, limit];

    return this.db.prepare(
      `SELECT * FROM memory_items
       WHERE embedding IS NOT NULL AND embedding_space_id = ?
       ${cursorPredicate}
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`,
    ).all(...params) as MemoryItemRow[];
  }

  browse(opts: MemoryItemsBrowseOptions = {}, now = Date.now()): MemoryItemRow[] {
    const where: string[] = ['(expires_at IS NULL OR expires_at > ?)'];
    const params: Array<string | number> = [now];

    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    if (typeof opts.minImportance === 'number') {
      where.push('importance >= ?');
      params.push(opts.minImportance);
    }
    if (opts.search) {
      where.push(`(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`);
      const pattern = '%' + escapeLikePattern(opts.search) + '%';
      params.push(pattern, pattern);
    }
    if (opts.executionProfile) {
      where.push('EXISTS (SELECT 1 FROM json_each(profiles_json) WHERE json_each.value = ?)');
      params.push(opts.executionProfile);
    }

    const orderBy = opts.orderBy === 'importance' ? 'importance DESC, id DESC'
                  : opts.orderBy === 'created'    ? 'created_at DESC, id DESC'
                  :                                  'last_referenced_at DESC, id DESC';
    const sql =
      `SELECT * FROM memory_items WHERE ${where.join(' AND ')}` +
      ` ORDER BY ${orderBy} LIMIT ?`;
    params.push(opts.limit ?? 100);

    return this.db.prepare(sql).all(...params) as MemoryItemRow[];
  }

  // ── 更新 ──────────────────────────────────────────────────────────────────

  /**
   * 将更新的 extraction 结果合并到已有 item 中。
   * 在不同 turn 中重新提取同一 title 时调用-知识已演进，
   * 故覆盖 body + importance 并替换 embedding。
   * `sourceTurnId` 更新为新 turn，使下次重试能识别。
   */
  updateBody(u: {
    id:                  string;
    body:                string;
    importance:          number;
    sourceTurnId?:       string;
    updatedAt:           number;
    embedding?:          Buffer;
    embeddingProviderId?: string;
    embeddingModel?:     string;
    embeddingDim?:       number;
    embeddingNormalization?: string;
    embeddingRevision?:  string;
    embeddingSpaceId?:   string;
  }): void {
    this.db
      .prepare(
        `UPDATE memory_items
            SET body               = ?,
                importance         = ?,
                source_turn_id     = COALESCE(?, source_turn_id),
                updated_at         = ?,
                embedding          = COALESCE(?, embedding),
                embedding_provider_id = COALESCE(?, embedding_provider_id),
                embedding_model    = COALESCE(?, embedding_model),
                embedding_dim      = COALESCE(?, embedding_dim),
                embedding_normalization = COALESCE(?, embedding_normalization),
                embedding_revision = COALESCE(?, embedding_revision),
                embedding_space_id = COALESCE(?, embedding_space_id),
                embedding_evicted_at = NULL
          WHERE id = ?`,
      )
      .run(
        u.body, u.importance,
        u.sourceTurnId ?? null,
        u.updatedAt,
        u.embedding          ?? null,
        u.embeddingProviderId ?? null,
        u.embeddingModel      ?? null,
        u.embeddingDim        ?? null,
        u.embeddingNormalization ?? null,
        u.embeddingRevision   ?? null,
        u.embeddingSpaceId    ?? null,
        u.id,
      );
  }

  updateEmbedding(u: MemoryItemEmbeddingUpdate): void {
    this.db
      .prepare(
        `UPDATE memory_items
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
   * 只修复扫描后没有发生变化且仍未过期的 stale 行。
   * Embedding 请求在事务外运行，这个 CAS 防止旧正文生成的向量覆盖并发更新。
   */
  repairEmbeddingIfUnchanged(u: MemoryItemEmbeddingRepair): boolean {
    const info = this.db
      .prepare(
        `UPDATE memory_items
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
            AND (embedding IS NULL OR embedding_space_id IS NOT ?)
            AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(
        u.embedding, u.embeddingProviderId, u.embeddingModel, u.embeddingDim,
        u.embeddingNormalization, u.embeddingRevision, u.embeddingSpaceId,
        u.updatedAt, u.id, u.expectedUpdatedAt, u.targetSpaceId, u.repairAt,
      );
    return info.changes === 1;
  }

  listDecayCandidates(
    cutoff: number,
    cycleCutoff: number,
    now: number,
    protectedKinds: readonly MemoryItemKind[] = [],
    limit = 5000,
  ): Array<{
    id: string;
    title: string;
    importance: number;
    last_referenced_at: number;
    last_decayed_at: number | null;
  }> {
    const exclusion = protectedKinds.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT id, title, importance, last_referenced_at, last_decayed_at
           FROM memory_items
          WHERE last_referenced_at < ?
            AND importance > 0
            AND (last_decayed_at IS NULL OR last_decayed_at < ?)
            AND (expires_at IS NULL OR expires_at > ?)
            ${exclusion ? `AND kind NOT IN (${exclusion})` : ''}
          ORDER BY last_referenced_at ASC, id ASC
          LIMIT ?`,
      )
      .all(cutoff, cycleCutoff, now, ...protectedKinds, limit) as Array<{
        id: string;
        title: string;
        importance: number;
        last_referenced_at: number;
        last_decayed_at: number | null;
      }>;
  }

  applyDecayUpdates(updates: MemoryItemDecayUpdate[]): string[] {
    if (updates.length === 0) return [];
    const stmt = this.db.prepare(
      `UPDATE memory_items
          SET importance = MAX(0, MIN(100, ?)),
              updated_at = ?,
              last_decayed_at = ?
        WHERE id = ?
          AND importance = ?
          AND last_referenced_at = ?
          AND last_decayed_at IS ?`,
    );
    const updatedIds: string[] = [];
    for (const u of updates) {
      const info = stmt.run(
        u.importance,
        u.updatedAt,
        u.updatedAt,
        u.id,
        u.expectedImportance,
        u.expectedLastReferencedAt,
        u.expectedLastDecayedAt,
      );
      if (info.changes === 1) updatedIds.push(u.id);
    }
    return updatedIds;
  }

  touchReferenced(ids: string[], at: number, boost?: MemoryReferenceBoostOptions): void {
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
              `UPDATE memory_items
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
      `UPDATE memory_items
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
        rows.push(...this.db.prepare(
          `SELECT id, importance, last_referenced_at
             FROM memory_items
            WHERE id IN (${placeholders})`,
        ).all(...batch) as Array<{ id: string; importance: number; last_referenced_at: number }>);
      }
      for (const row of rows) {
        const newImportance = boostedImportance(
          row.importance,
          row.last_referenced_at,
          at,
          boost,
        );
        stmt.run(newImportance, at, at, row.id);
      }
    });
    txn();
  }

  // ── 计数 / 启动诊断 ────────────────────────────────────────────

  countStaleEmbeddings(currentSpaceId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_items
         WHERE embedding IS NOT NULL AND embedding_space_id IS NOT ?`,
      )
      .get(currentSpaceId) as { n: number };
    return row.n;
  }

  /**
   * 待修复向量行（异空间或从未嵌入），按 (updated_at, id) 升序。
   * 修复成功的行自动离开结果集，分页进度隐式推进，无需游标持久化。
   * 已过期条目不重嵌——它们在清理路径上，不值得再烧配额。
   */
  listStaleEmbeddingPage(currentSpaceId: string, nowMs: number, limit: number): MemoryItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE embedding_evicted_at IS NULL
           AND (embedding IS NULL OR embedding_space_id IS NOT ?)
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY updated_at ASC, id ASC
         LIMIT ?`,
      )
      .all(currentSpaceId, nowMs, limit) as MemoryItemRow[];
  }

  /** 与 listStaleEmbeddingPage 同口径的计数，用于修复扫描报告剩余量。 */
  countRepairableEmbeddings(currentSpaceId: string, nowMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_items
         WHERE embedding_evicted_at IS NULL
           AND (embedding IS NULL OR embedding_space_id IS NOT ?)
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(currentSpaceId, nowMs) as { n: number };
    return row.n;
  }

  statsByKind(now: number): MemoryItemStatsRow[] {
    return this.db
      .prepare(
        `SELECT kind,
                COUNT(*) AS total,
                AVG(importance) AS avg_importance,
                SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded_count
           FROM memory_items
          WHERE expires_at IS NULL OR expires_at > ?
          GROUP BY kind`,
      )
      .all(now) as MemoryItemStatsRow[];
  }

  // ── 删除 ──────────────────────────────────────────────────────────────────

  delete(id: string): void {
    this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(id);
  }

  /** 清扫过期行。作为维护任务定期执行。 */
  deleteExpired(now: number): number {
    const info = this.db
      .prepare('DELETE FROM memory_items WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(now);
    return info.changes;
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

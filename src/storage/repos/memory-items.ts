import type { SqliteDb } from '../database.js';
import { createSqliteIdBatches } from '../sqlite-id-batches.js';
import { escapeLikePattern } from '../like-utils.js';
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { MemoryEmbeddingPageCursor } from './memory-embedding-page.js';

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
  modes_json:             string;
  last_referenced_at:     number;
  embedding_provider_id:  string | null;
  embedding_model:        string | null;
  embedding_dim:          number | null;
  embedding_normalization: string | null;
  embedding_revision:      string | null;
  embedding_space_id:      string | null;
}

export interface MemoryItemInsert {
  id:                  string;
  kind:                MemoryItemKind;
  title:               string;
  body:                string;
  modes:               string[];                  // 序列化到 modes_json
  embedding?:          Buffer;
  embeddingProviderId?: string;
  embeddingModel?:     string;
  embeddingDim?:       number;
  embeddingNormalization?: string;
  embeddingRevision?:  string;
  embeddingSpaceId?:   string;
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
  embeddingNormalization: string;
  embeddingRevision:   string;
  embeddingSpaceId:    string;
  updatedAt:           number;
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

export interface MemoryItemStatsRow {
  kind: MemoryItemKind;
  total: number;
  avg_importance: number | null;
  embedded_count: number;
}

export interface MemoryItemsBrowseOptions {
  limit?: number;
  kind?: MemoryItemKind;
  mode?: string;
  minImportance?: number;
  orderBy?: 'lastRef' | 'importance' | 'created';
  search?: string;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Layer-2 情景记忆 + Agent 长期记忆（4 种 kind）。
 *
 * `modes` 控制哪些对话 mode 会召回此 item：
 *   ["chat"]              - 仅在 chat mode 出现
 *   ["agent"]             - 仅在 agent mode 出现
 *   ["chat","agent"]      - 两者都出现（从跨 mode 事实提取的 item 默认值）
 * Mode 过滤在 planner 中是软加权-repo 只存标签，
 * 并为低成本路径暴露 listByMode。
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
            modes_json, last_referenced_at,
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
        JSON.stringify(m.modes),
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
   * 列出 modes_json 数组中包含给定 mode 标签的 item。
   * 使用 JSON1-我们打包的每个 SQLite 构建都有（better-sqlite3 默认）。
   */
  listByMode(mode: string, limit = 500): MemoryItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_items
          WHERE EXISTS (
            SELECT 1 FROM json_each(memory_items.modes_json)
             WHERE json_each.value = ?
          ) AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY importance DESC, updated_at DESC, id DESC
          LIMIT ?`,
      )
      .all(mode, Date.now(), limit) as MemoryItemRow[];
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
    if (opts.mode) {
      where.push('EXISTS (SELECT 1 FROM json_each(modes_json) WHERE json_each.value = ?)');
      params.push(opts.mode);
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
                embedding_space_id = COALESCE(?, embedding_space_id)
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
                updated_at            = ?
          WHERE id = ?`,
      )
      .run(
        u.embedding, u.embeddingProviderId, u.embeddingModel, u.embeddingDim,
        u.embeddingNormalization, u.embeddingRevision, u.embeddingSpaceId,
        u.updatedAt, u.id,
      );
  }

  listDecayCandidates(cutoff: number, now: number, limit = 5000): Array<{
    id: string;
    title: string;
    importance: number;
  }> {
    return this.db
      .prepare(
        `SELECT id, title, importance
           FROM memory_items
          WHERE last_referenced_at < ?
            AND importance > 0
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY last_referenced_at ASC, id ASC
          LIMIT ?`,
      )
      .all(cutoff, now, limit) as Array<{ id: string; title: string; importance: number }>;
  }

  applyImportanceUpdates(updates: Array<{ id: string; importance: number; updatedAt: number }>): void {
    if (updates.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE memory_items
          SET importance = MAX(0, MIN(100, ?)),
              updated_at = ?
        WHERE id = ?`,
    );
    const txn = this.db.transaction(() => {
      for (const u of updates) stmt.run(u.importance, u.updatedAt, u.id);
    });
    txn();
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
            .prepare(`UPDATE memory_items SET last_referenced_at = ? WHERE id IN (${placeholders})`)
            .run(at, ...batch);
        }
      })();
      return;
    }

    const stmt = this.db.prepare(
      `UPDATE memory_items
          SET importance = ?,
              last_referenced_at = ?,
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

  deleteZeroImportanceOlderThan(cutoff: number): number {
    const info = this.db
      .prepare(
        `DELETE FROM memory_items
          WHERE importance = 0 AND last_referenced_at < ?`,
      )
      .run(cutoff);
    return info.changes;
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

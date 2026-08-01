// 管理知识库文档资源的元数据、分页、激活记录和向量空间状态。
import type { SqliteDb } from '../../database/database.js';
import { escapeLikePattern } from '../../search/like-utils.js';
import { createSqliteIdBatches } from '../../database/sqlite-id-batches.js';

export interface DocumentAssetRow {
  id:                string;
  file_path:         string;
  file_name:         string;
  mime_type:         string;
  title:             string | null;
  word_count:        number;
  page_count:        number | null;
  status:            string;
  content_hash:      string | null;
  created_at:        number;
  updated_at:        number;
  ebd_model:         string | null;
  ebd_dim:           number | null;
  ebd_provider_id:   string | null;
  ebd_normalization: string | null;
  ebd_revision:      string | null;
  ebd_space_id:      string | null;
  ebd_stale:         number;
  use_count:         number;
  last_activated_at: number | null;
}

export interface DocumentAssetInsert {
  id:           string;
  filePath:     string;
  fileName:     string;
  mimeType:     string;
  title?:       string;
  wordCount:    number;
  pageCount?:   number;
  status:       string;
  contentHash?: string;
  createdAt:    number;
  updatedAt:    number;
}

export interface AssetPage {
  items:      ReturnType<typeof rowToAsset>[];
  nextCursor: string | null;   // V1 不透明复合 cursor（null = 结束）
}

interface DocumentAssetCursorV1 {
  v: 1;
  a: number;
  i: string;
}

export class DocumentAssetCursorError extends Error {
  readonly code = 'invalid_document_asset_cursor' as const;

  constructor(options?: ErrorOptions) {
    super('Invalid document asset cursor', options);
    this.name = 'DocumentAssetCursorError';
  }
}

function rowToAsset(row: DocumentAssetRow) {
  return {
    id:              row.id,
    filePath:        row.file_path,
    fileName:        row.file_name,
    mimeType:        row.mime_type,
    title:           row.title ?? undefined,
    wordCount:       row.word_count,
    pageCount:       row.page_count ?? undefined,
    status:          row.status as 'pending' | 'indexing' | 'indexed' | 'error',
    contentHash:     row.content_hash ?? undefined,
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
    ebdModel:        row.ebd_model ?? undefined,
    ebdDim:          row.ebd_dim ?? undefined,
    ebdProviderId:   row.ebd_provider_id ?? undefined,
    ebdNormalization: row.ebd_normalization ?? undefined,
    ebdRevision:     row.ebd_revision ?? undefined,
    ebdSpaceId:      row.ebd_space_id ?? undefined,
    ebdStale:        row.ebd_stale === 1,
    useCount:        row.use_count,
    lastActivatedAt: row.last_activated_at ?? undefined,
  };
}

export class DocumentAssetRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(a: DocumentAssetInsert): void {
    this.db
      .prepare(`INSERT INTO document_assets
        (id, file_path, file_name, mime_type, title, word_count, page_count, status, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.id, a.filePath, a.fileName, a.mimeType,
        a.title ?? null, a.wordCount, a.pageCount ?? null, a.status,
        a.contentHash ?? null, a.createdAt, a.updatedAt);
  }

  findByHash(contentHash: string): ReturnType<typeof rowToAsset> | undefined {
    const row = this.db
      .prepare('SELECT * FROM document_assets WHERE content_hash = ? LIMIT 1')
      .get(contentHash) as DocumentAssetRow | undefined;
    return row ? rowToAsset(row) : undefined;
  }

  findById(id: string): ReturnType<typeof rowToAsset> | undefined {
    const row = this.db.prepare('SELECT * FROM document_assets WHERE id = ?').get(id) as DocumentAssetRow | undefined;
    return row ? rowToAsset(row) : undefined;
  }

  /** 所有 asset（不分页）-用于索引/HNSW 预热，非 UI 列表。 */
  listAll(): ReturnType<typeof rowToAsset>[] {
    const rows = this.db.prepare(
      'SELECT * FROM document_assets ORDER BY created_at DESC, id DESC',
    ).all() as DocumentAssetRow[];
    return rows.map(rowToAsset);
  }

  /**
   * 面向 UI 的 keyset 分页列表，最新优先。Cursor 封装上一页最后一条的
   * `(created_at, id)`；首页传 undefined。可选对 file_name/title 搜索。
   */
  listPaged(opts: { cursor?: string; limit?: number; keyword?: string } = {}): AssetPage {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const where: string[] = [];
    const params: unknown[] = [];
    const cursor = parseDocumentAssetCursor(opts.cursor);
    if (cursor) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursor.a, cursor.a, cursor.i);
    }
    if (opts.keyword?.trim()) {
      where.push(`(file_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR IFNULL(title, '') LIKE ? ESCAPE '\\' COLLATE NOCASE)`);
      const like = '%' + escapeLikePattern(opts.keyword.trim()) + '%';
      params.push(like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // 取 limit+1 条以检测是否还有下一页。
    const rows = this.db
      .prepare(
        `SELECT * FROM document_assets ${whereSql}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(...params, limit + 1) as DocumentAssetRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(rowToAsset),
      nextCursor: hasMore ? encodeDocumentAssetCursor(pageRows[pageRows.length - 1]!) : null,
    };
  }

  /** 自 `beforeTs` 起未被选中的 KB（以 last_activated_at 为准，回退到 created_at）。 */
  listInactiveSince(beforeTs: number): ReturnType<typeof rowToAsset>[] {
    const rows = this.db.prepare(`
      SELECT * FROM document_assets
      WHERE COALESCE(last_activated_at, created_at) < ?
      ORDER BY COALESCE(last_activated_at, created_at) ASC
    `).all(beforeTs) as DocumentAssetRow[];
    return rows.map(rowToAsset);
  }

  /** 记录某 turn 选中这些 KB：自增 use_count + 更新 last_activated_at。 */
  recordActivation(ids: string[], ts: number): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      'UPDATE document_assets SET use_count = use_count + 1, last_activated_at = ? WHERE id = ?',
    );
    this.db.transaction(() => { for (const id of ids) stmt.run(ts, id); })();
  }

  updateStatus(id: string, status: string): void {
    this.db
      .prepare('UPDATE document_assets SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  patchMeta(id: string, meta: { title?: string; wordCount?: number; pageCount?: number }): void {
    this.db
      .prepare(`UPDATE document_assets
        SET title = COALESCE(?, title),
            word_count = COALESCE(?, word_count),
            page_count = COALESCE(?, page_count),
            updated_at = ?
        WHERE id = ?`)
      .run(meta.title ?? null, meta.wordCount ?? null, meta.pageCount ?? null, Date.now(), id);
  }

  setEmbeddingSpace(id: string, space: {
    id: string;
    providerId: string;
    model: string;
    dim: number;
    normalization: string;
    revision: string;
  }): void {
    this.db
      .prepare(`UPDATE document_assets
        SET ebd_provider_id = ?, ebd_model = ?, ebd_dim = ?,
            ebd_normalization = ?, ebd_revision = ?, ebd_space_id = ?,
            ebd_stale = 0, updated_at = ?
        WHERE id = ?`)
      .run(
        space.providerId, space.model, space.dim,
        space.normalization, space.revision, space.id,
        Date.now(), id,
      );
  }

  /** 返回当前 KB 数据库中真实存在的 ID，并保持调用方顺序且去重。 */
  findExistingIds(ids: readonly string[]): string[] {
    const existing = new Set<string>();
    for (const batch of createSqliteIdBatches(this.db, ids)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT id FROM document_assets WHERE id IN (${placeholders})`,
      ).all(...batch) as Array<{ id: string }>;
      for (const row of rows) existing.add(row.id);
    }
    return [...new Set(ids)].filter((id) => existing.has(id));
  }

  /** 将未用 currentModel embedding 的 indexed asset 标为 stale，同时清匹配的 stale=0。
   *  切换模型后调:新模型不匹配的标 stale(需重嵌),切回原模型时匹配的清 stale
   *  (之前只标不清,导致切回原模型按钮还在)。返回更新的行数。 */
  markStaleExcept(currentSpaceId: string): number {
    const info = this.db
      .prepare(`UPDATE document_assets
        SET ebd_stale = CASE WHEN ebd_space_id IS ? THEN 0 ELSE 1 END,
            updated_at = ?
        WHERE status = 'indexed'
          AND ebd_stale <> CASE WHEN ebd_space_id IS ? THEN 0 ELSE 1 END`)
      .run(currentSpaceId, Date.now(), currentSpaceId);
    return info.changes;
  }
  /** embedding 已 stale 的 asset（模型变更）-需重新 embedding。 */
  listEbdStale(): ReturnType<typeof rowToAsset>[] {
    const rows = this.db
      .prepare('SELECT * FROM document_assets WHERE ebd_stale = 1 ORDER BY created_at')
      .all() as DocumentAssetRow[];
    return rows.map(rowToAsset);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM document_assets WHERE id = ?').run(id);
  }
}

function encodeDocumentAssetCursor(row: Pick<DocumentAssetRow, 'created_at' | 'id'>): string {
  const payload: DocumentAssetCursorV1 = { v: 1, a: row.created_at, i: row.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function parseDocumentAssetCursor(cursor: string | undefined): DocumentAssetCursorV1 | null {
  if (cursor === undefined) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isDocumentAssetCursorV1(decoded)) {
      throw new Error('cursor payload schema mismatch');
    }
    return decoded;
  } catch (error) {
    throw new DocumentAssetCursorError({ cause: error });
  }
}

function isDocumentAssetCursorV1(value: unknown): value is DocumentAssetCursorV1 {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1
    && typeof candidate.a === 'number'
    && Number.isSafeInteger(candidate.a)
    && typeof candidate.i === 'string'
    && candidate.i.length > 0
    && candidate.i.length <= 512;
}

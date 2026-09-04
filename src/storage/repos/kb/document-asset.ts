// 管理知识库文档资源的元数据、分页和向量空间状态。
import type { SqliteDb } from '../../database/database.js';
import { escapeLikePattern } from '../../search/like-utils.js';
import { createSqliteIdBatches } from '../../database/sqlite-id-batches.js';

export interface DocumentAssetRow {
  id:                string;
  source_path:       string;
  file_path:         string;
  file_name:         string;
  mime_type:         string;
  title:             string | null;
  word_count:        number;
  page_count:        number | null;
  status:            string;
  created_at:        number;
  updated_at:        number;
  embedding_provider_id: string | null;
  embedding_model:   string | null;
  embedding_dim:     number | null;
  embedding_space_id: string | null;
  embedding_stale:   number;
}

export interface DocumentAssetInsert {
  id:           string;
  sourcePath:   string;
  filePath:     string;
  fileName:     string;
  mimeType:     string;
  title?:       string;
  wordCount:    number;
  pageCount?:   number;
  status:       string;
  createdAt:    number;
  updatedAt:    number;
}

export interface AssetPage {
  items:      ReturnType<typeof rowToAsset>[];
  nextCursor: string | null;   // 不透明复合 cursor（null = 结束）
}

interface DocumentAssetCursor {
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
    sourcePath:      row.source_path,
    filePath:        row.file_path,
    fileName:        row.file_name,
    mimeType:        row.mime_type,
    title:           row.title ?? undefined,
    wordCount:       row.word_count,
    pageCount:       row.page_count ?? undefined,
    status:          row.status as 'indexing' | 'ready' | 'failed',
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
    embeddingProviderId: row.embedding_provider_id ?? undefined,
    embeddingModel:  row.embedding_model ?? undefined,
    embeddingDim:    row.embedding_dim ?? undefined,
    embeddingSpaceId: row.embedding_space_id ?? undefined,
    embeddingStale:  row.embedding_stale === 1,
  };
}

export class DocumentAssetRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(a: DocumentAssetInsert): void {
    this.db
      .prepare(`INSERT INTO document_assets
        (id, source_path, file_path, file_name, mime_type, title, word_count, page_count, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.id, a.sourcePath, a.filePath, a.fileName, a.mimeType,
        a.title ?? null, a.wordCount, a.pageCount ?? null, a.status,
        a.createdAt, a.updatedAt);
  }

  /** 文档身份查询:同一原始路径再导入时找到既有资产。 */
  findBySourcePath(sourcePath: string): ReturnType<typeof rowToAsset> | undefined {
    const row = this.db
      .prepare('SELECT * FROM document_assets WHERE source_path = ? LIMIT 1')
      .get(sourcePath) as DocumentAssetRow | undefined;
    return row ? rowToAsset(row) : undefined;
  }

  findById(id: string): ReturnType<typeof rowToAsset> | undefined {
    const row = this.db.prepare('SELECT * FROM document_assets WHERE id = ?').get(id) as DocumentAssetRow | undefined;
    return row ? rowToAsset(row) : undefined;
  }

  /** 面向 UI 的 keyset 分页列表，最新优先。Cursor 封装上一页最后一条的
   *  `(created_at, id)`；首页传 undefined。可选对 file_name/title 搜索。 */
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
  }): void {
    this.db
      .prepare(`UPDATE document_assets
        SET embedding_provider_id = ?, embedding_model = ?, embedding_dim = ?,
            embedding_space_id = ?, embedding_stale = 0, updated_at = ?
        WHERE id = ?`)
      .run(
        space.providerId, space.model, space.dim, space.id,
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
        SET embedding_stale = CASE WHEN embedding_space_id IS ? THEN 0 ELSE 1 END,
            updated_at = ?
        WHERE status = 'ready'
          AND embedding_stale <> CASE WHEN embedding_space_id IS ? THEN 0 ELSE 1 END`)
      .run(currentSpaceId, Date.now(), currentSpaceId);
    return info.changes;
  }
  /** embedding 已 stale 的 asset（模型变更）——需重新 embedding。 */
  listEmbeddingStale(): ReturnType<typeof rowToAsset>[] {
    const rows = this.db
      .prepare('SELECT * FROM document_assets WHERE embedding_stale = 1 ORDER BY created_at')
      .all() as DocumentAssetRow[];
    return rows.map(rowToAsset);
  }

  /** 文档计数概览(库卡/覆盖率徽标): 总数 / 就绪数 / 待重建数。 */
  countByIndexState(): { total: number; ready: number; stale: number } {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'ready'), 0)  AS ready,
              COALESCE(SUM(embedding_stale = 1), 0) AS stale
         FROM document_assets`,
    ).get() as { total: number; ready: number; stale: number };
    return row;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM document_assets WHERE id = ?').run(id);
  }
}

function encodeDocumentAssetCursor(row: Pick<DocumentAssetRow, 'created_at' | 'id'>): string {
  const payload: DocumentAssetCursor = { a: row.created_at, i: row.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function parseDocumentAssetCursor(cursor: string | undefined): DocumentAssetCursor | null {
  if (cursor === undefined) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isDocumentAssetCursor(decoded)) {
      throw new Error('cursor payload schema mismatch');
    }
    return decoded;
  } catch (error) {
    throw new DocumentAssetCursorError({ cause: error });
  }
}

function isDocumentAssetCursor(value: unknown): value is DocumentAssetCursor {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.a === 'number'
    && Number.isSafeInteger(candidate.a)
    && typeof candidate.i === 'string'
    && candidate.i.length > 0
    && candidate.i.length <= 512;
}

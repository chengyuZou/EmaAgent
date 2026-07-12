import type { SqliteDb } from '../database.js';

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
  nextCursor: number | null;   // 下一页的 created_at cursor（null = 结束）
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
    const rows = this.db.prepare('SELECT * FROM document_assets ORDER BY created_at DESC').all() as DocumentAssetRow[];
    return rows.map(rowToAsset);
  }

  /**
   * 面向 UI 的 cursor 分页列表，最新优先。Cursor = 上一页最后一条的 created_at；
   * 首页传 undefined。可选对 file_name/title 做大小写不敏感的关键词搜索。
   */
  listPaged(opts: { cursor?: number; limit?: number; keyword?: string } = {}): AssetPage {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.cursor !== undefined) { where.push('created_at < ?'); params.push(opts.cursor); }
    if (opts.keyword?.trim()) {
      where.push('(file_name LIKE ? COLLATE NOCASE OR IFNULL(title, \'\') LIKE ? COLLATE NOCASE)');
      const like = `%${opts.keyword.trim()}%`;
      params.push(like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // 取 limit+1 条以检测是否还有下一页。
    const rows = this.db
      .prepare(`SELECT * FROM document_assets ${whereSql} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit + 1) as DocumentAssetRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(rowToAsset);
    return { items: page, nextCursor: hasMore ? page[page.length - 1]!.createdAt : null };
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

  setEbdModel(id: string, model: string, dim: number): void {
    this.db
      .prepare('UPDATE document_assets SET ebd_model = ?, ebd_dim = ?, ebd_stale = 0, updated_at = ? WHERE id = ?')
      .run(model, dim, Date.now(), id);
  }

  /** 将未用 currentModel embedding 的 indexed asset 标为 stale，同时清匹配的 stale=0。
   *  切换模型后调:新模型不匹配的标 stale(需重嵌),切回原模型时匹配的清 stale
   *  (之前只标不清,导致切回原模型按钮还在)。返回更新的行数。 */
  markStaleExcept(currentModel: string): number {
    const info = this.db
      .prepare(`UPDATE document_assets
        SET ebd_stale = CASE WHEN (ebd_model IS NULL OR ebd_model != ?) THEN 1 ELSE 0 END,
            updated_at = ?
        WHERE status = 'indexed'`)
      .run(currentModel, Date.now());
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

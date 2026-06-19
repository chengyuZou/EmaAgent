import type { SqliteDb } from '../database.js';

export interface DocumentAssetRow {
  id:           string;
  scope:        string;
  session_id:   string | null;
  file_path:    string;
  file_name:    string;
  mime_type:    string;
  title:        string | null;
  word_count:   number;
  page_count:   number | null;
  status:       string;
  content_hash: string | null;
  created_at:   number;
  updated_at:   number;
  ebd_model:    string | null;
  ebd_dim:      number | null;
  ebd_stale:    number;
}

export interface DocumentAssetInsert {
  id:           string;
  scope:        'global' | 'session';
  sessionId?:   string;
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

function rowToAsset(row: DocumentAssetRow) {
  return {
    id:          row.id,
    scope:       row.scope as 'global' | 'session',
    sessionId:   row.session_id ?? undefined,
    filePath:    row.file_path,
    fileName:    row.file_name,
    mimeType:    row.mime_type,
    title:       row.title ?? undefined,
    wordCount:   row.word_count,
    pageCount:   row.page_count ?? undefined,
    status:      row.status as 'pending' | 'indexing' | 'indexed' | 'error',
    contentHash: row.content_hash ?? undefined,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
    ebdModel:    row.ebd_model ?? undefined,
    ebdDim:      row.ebd_dim ?? undefined,
    ebdStale:    row.ebd_stale === 1,
  };
}

export class DocumentAssetRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(a: DocumentAssetInsert): void {
    this.db
      .prepare(`INSERT INTO document_assets
        (id, scope, session_id, file_path, file_name, mime_type, title, word_count, page_count, status, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.id, a.scope, a.sessionId ?? null, a.filePath, a.fileName, a.mimeType,
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

  listByScope(scope: 'global' | 'session', sessionId?: string): ReturnType<typeof rowToAsset>[] {
    let rows: DocumentAssetRow[];
    if (scope === 'session' && sessionId) {
      rows = this.db.prepare('SELECT * FROM document_assets WHERE scope = ? AND session_id = ? ORDER BY created_at DESC').all(scope, sessionId) as DocumentAssetRow[];
    } else {
      rows = this.db.prepare('SELECT * FROM document_assets WHERE scope = ? ORDER BY created_at DESC').all(scope) as DocumentAssetRow[];
    }
    return rows.map(rowToAsset);
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

  /** Mark all assets whose ebd_model differs from currentModel as stale.
   *  Returns the number of rows updated. */
  markStaleExcept(currentModel: string): number {
    const info = this.db
      .prepare(`UPDATE document_assets
        SET ebd_stale = 1, updated_at = ?
        WHERE ebd_model IS NOT NULL AND ebd_model != ?`)
      .run(Date.now(), currentModel);
    return info.changes;
  }

  listStale(): ReturnType<typeof rowToAsset>[] {
    const rows = this.db
      .prepare('SELECT * FROM document_assets WHERE ebd_stale = 1 ORDER BY created_at')
      .all() as DocumentAssetRow[];
    return rows.map(rowToAsset);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM document_assets WHERE id = ?').run(id);
  }
}

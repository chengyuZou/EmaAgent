import type { SqliteDb } from '../database.js';

export interface DocumentPreviewRow {
  asset_id:       string;
  text:           string;
  thumbnail:      Buffer | null;
  thumbnail_mime: string | null;
  page_count:     number | null;
  word_count:     number;
}

export interface DocumentPreviewUpsert {
  assetId:        string;
  text:           string;
  thumbnail?:     Uint8Array;
  thumbnailMime?: string;
  pageCount?:     number;
  wordCount:      number;
}

function rowToPreview(row: DocumentPreviewRow) {
  return {
    assetId:        row.asset_id,
    text:           row.text,
    thumbnail:      row.thumbnail ? new Uint8Array(row.thumbnail) : undefined,
    thumbnailMime:  (row.thumbnail_mime ?? undefined) as 'image/png' | undefined,
    pageCount:      row.page_count ?? undefined,
    wordCount:      row.word_count,
  };
}

export class DocumentPreviewRepo {
  constructor(private readonly db: SqliteDb) {}

  upsert(p: DocumentPreviewUpsert): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO document_previews
          (asset_id, text, thumbnail, thumbnail_mime, page_count, word_count)
        VALUES (?, ?, ?, ?, ?, ?)`)
      .run(p.assetId, p.text,
        p.thumbnail ? Buffer.from(p.thumbnail) : null,
        p.thumbnailMime ?? null,
        p.pageCount ?? null,
        p.wordCount);
  }

  findByAsset(assetId: string): ReturnType<typeof rowToPreview> | undefined {
    const row = this.db
      .prepare('SELECT * FROM document_previews WHERE asset_id = ?')
      .get(assetId) as DocumentPreviewRow | undefined;
    return row ? rowToPreview(row) : undefined;
  }
}

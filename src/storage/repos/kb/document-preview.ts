import type { SqliteDb } from '../../database/database.js';

export interface DocumentPreviewRow {
  asset_id:       string;
  text:           string;
  thumbnail:      Buffer | null;
  thumbnail_mime: string | null;
  page_count:     number | null;
  word_count:     number;
}

export type DocumentPreviewMime = 'image/png';

export interface DocumentPreview {
  assetId:        string;
  text:           string;
  thumbnail?:     Uint8Array;
  thumbnailMime?: DocumentPreviewMime;
  pageCount?:     number;
  wordCount:      number;
}

export interface DocumentPreviewUpsert {
  assetId:        string;
  text:           string;
  thumbnail?:     Uint8Array;
  thumbnailMime?: DocumentPreviewMime;
  pageCount?:     number;
  wordCount:      number;
}

export class DocumentPreviewValidationError extends Error {
  readonly code = 'storage/document-preview-invalid';

  constructor(readonly assetId: string, readonly reason: string) {
    super(`Invalid document preview for asset "${assetId}": ${reason}`);
    this.name = 'DocumentPreviewValidationError';
  }
}

function validateThumbnailPair(
  assetId: string,
  thumbnail: Uint8Array | Buffer | null | undefined,
  thumbnailMime: string | null | undefined,
): void {
  const hasThumbnail = thumbnail !== undefined && thumbnail !== null;
  const hasMime = thumbnailMime !== undefined && thumbnailMime !== null;
  if (hasThumbnail !== hasMime) {
    throw new DocumentPreviewValidationError(
      assetId,
      'thumbnail and thumbnail MIME must be provided together',
    );
  }
  if (hasMime && thumbnailMime !== 'image/png') {
    throw new DocumentPreviewValidationError(
      assetId,
      `unsupported thumbnail MIME "${thumbnailMime}"`,
    );
  }
}

function rowToPreview(row: DocumentPreviewRow): DocumentPreview {
  validateThumbnailPair(row.asset_id, row.thumbnail, row.thumbnail_mime);
  const thumbnailMime: DocumentPreviewMime | undefined =
    row.thumbnail_mime === 'image/png' ? row.thumbnail_mime : undefined;
  return {
    assetId:        row.asset_id,
    text:           row.text,
    thumbnail:      row.thumbnail ? new Uint8Array(row.thumbnail) : undefined,
    thumbnailMime,
    pageCount:      row.page_count ?? undefined,
    wordCount:      row.word_count,
  };
}

export class DocumentPreviewRepo {
  constructor(private readonly db: SqliteDb) {}

  upsert(p: DocumentPreviewUpsert): void {
    validateThumbnailPair(p.assetId, p.thumbnail, p.thumbnailMime);
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

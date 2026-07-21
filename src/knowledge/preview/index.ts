import type { DocumentBlock, DocumentPreview } from '../types.js';
import { extractSummary } from './summary.js';
import { countWords } from '../words.js';
import { imageThumbnail, pdfThumbnail } from './thumbnail.js';

export interface BuildPreviewOpts {
  assetId:    string;
  mimeType:   string;
  pageCount?: number;
  bytes?:     Uint8Array;
}

export async function buildPreview(blocks: DocumentBlock[], opts: BuildPreviewOpts): Promise<DocumentPreview> {
  let thumbnail:     Uint8Array | undefined;
  let thumbnailMime: 'image/png' | undefined;

  if (opts.bytes) {
    if (opts.mimeType.startsWith('image/')) {
      thumbnail     = await imageThumbnail(opts.bytes);
      thumbnailMime = thumbnail ? 'image/png' : undefined;
    } else if (opts.mimeType === 'application/pdf') {
      thumbnail     = await pdfThumbnail(opts.bytes);
      thumbnailMime = thumbnail ? 'image/png' : undefined;
    }
  }

  return {
    assetId:   opts.assetId,
    text:      extractSummary(blocks),
    wordCount: countWords(blocks),
    ...(opts.pageCount !== undefined ? { pageCount: opts.pageCount } : {}),
    ...(thumbnail ? { thumbnail, thumbnailMime } : {}),
  };
}

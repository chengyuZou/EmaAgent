import type { Element, DocumentPreview } from './types.js';

const PREVIEW_TEXT_CHARS = 400;
const THUMBNAIL_WIDTH    = 320;
const THUMBNAIL_HEIGHT   = 240;

/**
 * Generate a DocumentPreview from a parsed element list.
 *
 * Text preview: first PREVIEW_TEXT_CHARS chars from body elements (skips titles).
 * Thumbnail:
 *   - Images: resized via sharp
 *   - PDFs:   first page rendered via pdfjs-dist + canvas (optional dep)
 *   - Others: undefined (caller shows a generic icon)
 */
export async function buildPreview(
  elements:  Element[],
  opts: {
    mimeType:  string;
    pageCount?: number;
    /** Raw source bytes — needed for image/pdf thumbnail generation. */
    bytes?:    Uint8Array;
  },
): Promise<DocumentPreview> {
  const bodyText = elements
    .filter(e => e.kind !== 'title' && e.kind !== 'image')
    .map(e => e.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PREVIEW_TEXT_CHARS);

  const wordCount = elements
    .filter(e => e.kind !== 'image')
    .reduce((n, e) => n + e.text.split(/\s+/).filter(Boolean).length, 0);

  let thumbnail: Uint8Array | undefined;
  let thumbnailMime: 'image/png' | undefined;

  if (opts.bytes) {
    if (opts.mimeType.startsWith('image/')) {
      thumbnail     = await imageThumb(opts.bytes, opts.mimeType);
      thumbnailMime = thumbnail ? 'image/png' : undefined;
    } else if (opts.mimeType === 'application/pdf') {
      thumbnail     = await pdfThumb(opts.bytes);
      thumbnailMime = thumbnail ? 'image/png' : undefined;
    }
  }

  return {
    text: bodyText,
    ...(thumbnail ? { thumbnail, thumbnailMime } : {}),
    ...(opts.pageCount !== undefined ? { pageCount: opts.pageCount } : {}),
    wordCount,
  };
}

// ── Thumbnail helpers ─────────────────────────────────────────────────────────

async function imageThumb(bytes: Uint8Array, _mime: string): Promise<Uint8Array | undefined> {
  try {
    const sharp = (await import('sharp')).default;
    const buf   = await sharp(Buffer.from(bytes))
      .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    return new Uint8Array(buf);
  } catch {
    return undefined;
  }
}

async function pdfThumb(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  try {
    // canvas is an optional dep — skip thumbnail gracefully if absent
    const { createCanvas } = await import('canvas');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    const pdf  = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
    const page = await pdf.getPage(1);

    const viewport = page.getViewport({ scale: 1 });
    const scale    = Math.min(
      THUMBNAIL_WIDTH  / viewport.width,
      THUMBNAIL_HEIGHT / viewport.height,
    );
    const scaled   = page.getViewport({ scale });

    const canvas  = createCanvas(Math.round(scaled.width), Math.round(scaled.height));
    const context = canvas.getContext('2d');

    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport:      scaled,
    }).promise;

    return new Uint8Array(canvas.toBuffer('image/png'));
  } catch {
    return undefined;
  }
}

import { readFile } from 'node:fs/promises';
import type { DocumentBlock } from '../types.js';
import type { DocumentReader, ReadFailure, ReadResult, ReaderSource } from './base.js';
import { nextBlockId } from './base.js';
import type { ImageReader } from './image.js';
import { isKbVisionAdapterError } from '../adapters/vision.js';

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// Resolve the worker from the installed package so the path is correct regardless
// of how this module is bundled or run (tsx, Node, compiled).
const _require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  _require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const HEADING_SCALE = 1.25;
// A page whose text layer has fewer than this many non-space chars is treated as
// image-only (scanned) and routed to OCR. Decided PER PAGE so mixed documents
// (some digital pages, some scanned) don't silently lose the scanned pages.
const MIN_PAGE_TEXT_CHARS = 30;
// Render scale for OCR rasterization — higher = better OCR, slower.
const OCR_RENDER_SCALE = 2.0;

interface PdfItem { str: string; height: number }

export class PdfReader implements DocumentReader {
  /**
   * @param imageReader Optional vision-backed OCR reader. When provided, pages
   *   without a usable text layer are rasterized and OCR'd. When absent, such
   *   pages emit a placeholder block (legacy behaviour) instead of being dropped.
   */
  constructor(private readonly imageReader?: ImageReader) {}

  async read(source: ReaderSource): Promise<ReadResult> {
    const data = source.kind === 'path'
      ? new Uint8Array(await readFile(source.path))
      : source.bytes;

    const pdf       = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
    const blocks:   DocumentBlock[] = [];
    const failures: ReadFailure[] = [];
    const stack:    string[] = [];
    const pageCount = pdf.numPages;

    for (let p = 1; p <= pageCount; p++) {
      // Per-page isolation: one broken/unrenderable page must not abort the whole
      // document (handles truncated/corrupt PDFs — 缺页/断页).
      let page;
      try {
        page = await pdf.getPage(p);
      } catch (error) {
        blocks.push(brokenPageBlock(p));
        failures.push(pageFailure(p, 'kb/pdf-page-unreadable', false, error));
        continue;
      }

      let items: PdfItem[] = [];
      let textLayerError: unknown;
      try {
        const content = await page.getTextContent();
        items = content.items
          .filter((it): it is typeof it & { str: string } => 'str' in it)
          .map(it => ({ str: (it as { str: string }).str, height: (it as { height?: number }).height ?? 0 }));
      } catch (error) {
        items = [];
        textLayerError = error;
      }

      const pageTextLen = items.reduce((n, it) => n + it.str.replace(/\s/g, '').length, 0);

      // ── Digital page: use the text layer ────────────────────────────────────
      if (pageTextLen >= MIN_PAGE_TEXT_CHARS) {
        const median   = medianHeight(items);
        const pageBlks = itemsToBlocks(items, median, p, stack);
        mergeContinuation(blocks, pageBlks);
        continue;
      }

      // ── Image-only / scanned page: OCR if a vision reader is available ──────
      if (this.imageReader) {
        try {
          const png = await renderPageToPng(page as unknown as RenderablePage, OCR_RENDER_SCALE);
          if (png) {
            const res = await this.imageReader.read({ kind: 'bytes', bytes: png, name: `page-${p}.png` });
            const ocrBlks = res.blocks
              .filter(b => b.text.trim())
              .map(b => ({ ...b, id: nextBlockId(), page: p, sectionPath: [...stack] }));
            if (ocrBlks.length > 0) { blocks.push(...ocrBlks); continue; }
          }
          blocks.push(scannedPlaceholder(p));
          failures.push(pageFailure(
            p,
            'kb/pdf-ocr-empty',
            true,
            textLayerError ?? new Error('OCR 未返回可索引文本'),
          ));
        } catch (error) {
          if (isKbVisionAdapterError(error) && error.code === 'vision/aborted') throw error;
          // 单页失败不终止其他页面，但必须写入持久失败分片，不能伪装成完整成功。
          blocks.push(scannedPlaceholder(p));
          failures.push(pageFailure(
            p,
            isKbVisionAdapterError(error) ? error.code : 'kb/pdf-ocr-failed',
            isKbVisionAdapterError(error) ? error.retryable : true,
            error,
          ));
        }
        continue;
      }

      // No OCR capability: keep a placeholder so the page isn't silently dropped.
      blocks.push(scannedPlaceholder(p));
      failures.push(pageFailure(
        p,
        'kb/pdf-ocr-unavailable',
        false,
        textLayerError ?? new Error('当前未配置 PDF OCR 能力'),
      ));
    }

    return { blocks, pageCount, failures };
  }
}

// ── Cross-page paragraph continuation merge ─────────────────────────────────────

function mergeContinuation(blocks: DocumentBlock[], pageBlks: DocumentBlock[]): void {
  if (blocks.length > 0 && pageBlks.length > 0) {
    const last  = blocks[blocks.length - 1]!;
    const first = pageBlks[0]!;
    if (last.kind === 'paragraph' && first.kind === 'paragraph' &&
        !endsWithPunct(last.text) && looksLikeContinuation(first.text)) {
      last.text = last.text.trimEnd() + ' ' + first.text.trimStart();
      blocks.push(...pageBlks.slice(1));
      return;
    }
  }
  blocks.push(...pageBlks);
}

// ── Page rasterization (for OCR) ────────────────────────────────────────────────

interface RenderablePage {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: unknown) => { promise: Promise<void> };
}

async function renderPageToPng(page: RenderablePage, scale: number): Promise<Uint8Array | undefined> {
  try {
    const { createCanvas } = await import('canvas');
    const vp     = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    await page.render({
      canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
      viewport: vp,
    }).promise;
    return new Uint8Array(canvas.toBuffer('image/png'));
  } catch {
    // `canvas` native module unavailable or render failed — caller falls back.
    return undefined;
  }
}

function scannedPlaceholder(page: number): DocumentBlock {
  return { id: nextBlockId(), kind: 'image', text: `[Scanned page ${page} — OCR unavailable]`, page, sectionPath: [] };
}
function brokenPageBlock(page: number): DocumentBlock {
  return { id: nextBlockId(), kind: 'image', text: `[Page ${page} could not be read]`, page, sectionPath: [] };
}

function pageFailure(
  page: number,
  errorCode: string,
  retryable: boolean,
  error: unknown,
): ReadFailure {
  return {
    shardKey: `parse:page:${page}`,
    itemIds: [String(page)],
    retryable,
    errorCode,
    error: error instanceof Error ? error.message : String(error),
  };
}

// ── Text-layer → blocks ─────────────────────────────────────────────────────────

function medianHeight(items: PdfItem[]): number {
  const hs = items.map(it => it.height).filter(h => h > 0).sort((a, b) => a - b);
  return hs.length === 0 ? 12 : hs[Math.floor(hs.length / 2)]!;
}

function itemsToBlocks(items: PdfItem[], median: number, page: number, stack: string[]): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  let buf = '', bufH = 0;

  const flush = (): void => {
    const text = buf.trim();
    buf = '';
    if (!text) return;
    if (bufH > median * HEADING_SCALE) {
      const level = hToLevel(bufH, median);
      while (stack.length >= level) stack.pop();
      stack.push(text);
      blocks.push({ id: nextBlockId(), kind: 'title', text, level, page, sectionPath: stack.slice(0, -1) });
    } else {
      const isList = /^[•\-–*]\s/.test(text) || /^\d+[.)]\s/.test(text);
      blocks.push({ id: nextBlockId(), kind: isList ? 'list_item' : 'paragraph',
        text: isList ? text.replace(/^[•\-–*\d.)\s]+/, '').trim() : text,
        page, sectionPath: [...stack] });
    }
  };

  for (const item of items) {
    if (!item.str.trim() && buf) { flush(); continue; }
    if (buf && item.height > 0 && Math.abs(item.height - bufH) > 1) flush();
    if (item.str.trim()) { buf += (buf ? ' ' : '') + item.str.trim(); bufH = item.height || bufH; }
  }
  flush();
  return blocks;
}

function hToLevel(h: number, median: number): number {
  const r = h / median;
  if (r >= 2.0) return 1; if (r >= 1.6) return 2; if (r >= 1.3) return 3; return 4;
}
function endsWithPunct(t: string): boolean { return /[.!?。！？;；:：]\s*$/.test(t.trimEnd()); }
function looksLikeContinuation(t: string): boolean {
  t = t.trimStart();
  if (!t) return false;
  if (/^[a-z]/.test(t)) return true;
  return /^(though|however|and|or|but|which|that|where|when|while|as|if|since|because|therefore|thus|hence|so|yet|nor|for|although|whereas|unless|until|after|before|once|provided|given)\b/i.test(t);
}

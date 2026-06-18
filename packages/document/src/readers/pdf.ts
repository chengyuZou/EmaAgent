import { readFile } from 'node:fs/promises';
import type { Element } from '../types.js';
import type { DocumentReader, ReaderSource } from './base.js';
import { nextElementId } from './base.js';

// pdfjs-dist is ESM with a legacy NodeJS entry; we import the node build.
// The `canvas` optional dep is used only for thumbnail rendering (preview.ts).
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// Suppress the "fake worker" warning in Node
pdfjs.GlobalWorkerOptions.workerSrc = '';

// ── Heading detection heuristics ──────────────────────────────────────────────

// A text item is treated as a heading when its font height is meaningfully
// larger than the page's median body text height.
const HEADING_SCALE_THRESHOLD = 1.25;

interface PdfTextItem {
  str:       string;
  height:    number;
  fontName?: string;
  bold?:     boolean;
}

/**
 * Reads a PDF file using pdfjs-dist. Extracts text with font-size-based
 * heading detection. Scanned PDFs (no selectable text) return a single
 * image element indicating that OCR is needed.
 */
export class PdfReader implements DocumentReader {
  async read(source: ReaderSource): Promise<Element[]> {
    const data = source.kind === 'path'
      ? new Uint8Array(await readFile(source.path))
      : source.bytes;

    const pdf      = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
    const elements: Element[] = [];
    const sectionStack: string[] = [];
    let totalTextLength = 0;

    for (let p = 1; p <= pdf.numPages; p++) {
      const page    = await pdf.getPage(p);
      const content = await page.getTextContent();

      const items: PdfTextItem[] = content.items
        .filter((it): it is typeof it & { str: string } => 'str' in it && typeof it.str === 'string')
        .map(it => ({
          str:      (it as { str: string }).str,
          height:   (it as { height?: number }).height ?? 0,
          fontName: (it as { fontName?: string }).fontName,
        }));

      if (items.every(it => !it.str.trim())) continue;
      totalTextLength += items.reduce((s, it) => s + it.str.length, 0);

      const medianHeight = computeMedianHeight(items);
      const pageElements = itemsToElements(items, medianHeight, p, sectionStack);

      // Cross-page paragraph stitching: if the last paragraph on the previous
      // page ends mid-sentence and the first element on this page is a
      // continuation paragraph, merge them into one element.
      if (elements.length > 0 && pageElements.length > 0) {
        const lastEl      = elements[elements.length - 1]!;
        const firstPageEl = pageElements[0]!;
        if (
          lastEl.kind      === 'paragraph' &&
          firstPageEl.kind === 'paragraph' &&
          !endsWithTerminalPunct(lastEl.text) &&
          looksLikeContinuation(firstPageEl.text)
        ) {
          lastEl.text = lastEl.text.trimEnd() + ' ' + firstPageEl.text.trimStart();
          elements.push(...pageElements.slice(1));
          continue;
        }
      }

      elements.push(...pageElements);
    }

    // Heuristic: if we extracted almost no text, this is likely a scanned PDF.
    if (totalTextLength < 100 && pdf.numPages > 0) {
      return [{
        id:          nextElementId(),
        kind:        'image',
        text:        '[Scanned PDF — OCR required]',
        page:        1,
        sectionPath: [],
      }];
    }

    return elements;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeMedianHeight(items: PdfTextItem[]): number {
  const heights = items
    .map(it => it.height)
    .filter(h => h > 0)
    .sort((a, b) => a - b);
  if (heights.length === 0) return 12;
  return heights[Math.floor(heights.length / 2)]!;
}

function itemsToElements(
  items:         PdfTextItem[],
  medianHeight:  number,
  page:          number,
  sectionStack:  string[],
): Element[] {
  const elements: Element[] = [];
  // Group consecutive items into lines (same approximate y; simplified: just group by run)
  let buf = '';
  let bufHeight = 0;

  const flush = (): void => {
    const text = buf.trim();
    buf = '';
    if (!text) return;

    const isHeading = bufHeight > medianHeight * HEADING_SCALE_THRESHOLD;
    if (isHeading) {
      const level = heightToLevel(bufHeight, medianHeight);
      while (sectionStack.length >= level) sectionStack.pop();
      sectionStack.push(text);
      elements.push({
        id: nextElementId(),
        kind: 'title',
        text,
        level,
        page,
        sectionPath: sectionStack.slice(0, -1),
      });
    } else {
      // Treat as paragraph or list item based on leading bullet
      const isList = /^[•\-–*]\s/.test(text) || /^\d+[.)]\s/.test(text);
      elements.push({
        id: nextElementId(),
        kind: isList ? 'list_item' : 'paragraph',
        text: isList ? text.replace(/^[•\-–*\d.)\s]+/, '').trim() : text,
        page,
        sectionPath: [...sectionStack],
      });
    }
  };

  for (const item of items) {
    if (!item.str.trim() && buf) {
      flush();
      continue;
    }
    // New run at a noticeably different height → flush current buffer
    if (buf && item.height > 0 && Math.abs(item.height - bufHeight) > 1) {
      flush();
    }
    if (item.str.trim()) {
      buf       += (buf ? ' ' : '') + item.str.trim();
      bufHeight  = item.height || bufHeight;
    }
  }
  flush();

  return elements;
}

function heightToLevel(height: number, median: number): number {
  const ratio = height / median;
  if (ratio >= 2.0) return 1;
  if (ratio >= 1.6) return 2;
  if (ratio >= 1.3) return 3;
  return 4;
}

/** True when the text ends with a recognized sentence-terminal character. */
function endsWithTerminalPunct(text: string): boolean {
  return /[.!?。！？;；:：]\s*$/.test(text.trimEnd());
}

/**
 * True when the text looks like a continuation of a prior sentence:
 * starts with a lowercase letter, or with a common connector word.
 */
function looksLikeContinuation(text: string): boolean {
  const t = text.trimStart();
  if (!t) return false;
  // Starts with a lowercase ASCII letter
  if (/^[a-z]/.test(t)) return true;
  // Starts with a connector word (case-insensitive)
  return /^(though|however|and|or|but|which|that|where|when|while|as|if|since|because|therefore|thus|hence|so|yet|nor|for|although|whereas|unless|until|after|before|once|provided|given)\b/i
    .test(t);
}

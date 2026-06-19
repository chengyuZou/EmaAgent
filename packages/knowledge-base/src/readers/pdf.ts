import { readFile } from 'node:fs/promises';
import type { DocumentBlock } from '../types.js';
import type { DocumentReader, ReadResult, ReaderSource } from './base.js';
import { nextBlockId } from './base.js';

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

interface PdfItem { str: string; height: number }

export class PdfReader implements DocumentReader {
  async read(source: ReaderSource): Promise<ReadResult> {
    const data = source.kind === 'path'
      ? new Uint8Array(await readFile(source.path))
      : source.bytes;

    const pdf      = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
    const blocks:  DocumentBlock[] = [];
    const stack:   string[] = [];
    let totalLen   = 0;

    for (let p = 1; p <= pdf.numPages; p++) {
      const page    = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items:  PdfItem[] = content.items
        .filter((it): it is typeof it & { str: string } => 'str' in it)
        .map(it => ({ str: (it as { str: string }).str, height: (it as { height?: number }).height ?? 0 }));

      if (items.every(it => !it.str.trim())) continue;
      totalLen += items.reduce((n, it) => n + it.str.length, 0);

      const median   = medianHeight(items);
      const pageBlks = itemsToBlocks(items, median, p, stack);

      if (blocks.length > 0 && pageBlks.length > 0) {
        const last  = blocks[blocks.length - 1]!;
        const first = pageBlks[0]!;
        if (last.kind === 'paragraph' && first.kind === 'paragraph' &&
            !endsWithPunct(last.text) && looksLikeContinuation(first.text)) {
          last.text = last.text.trimEnd() + ' ' + first.text.trimStart();
          blocks.push(...pageBlks.slice(1));
          continue;
        }
      }
      blocks.push(...pageBlks);
    }

    const pageCount = pdf.numPages;
    if (totalLen < 100 && pageCount > 0) {
      return {
        blocks: [{ id: nextBlockId(), kind: 'image', text: '[Scanned PDF — OCR required]', page: 1, sectionPath: [] }],
        pageCount,
      };
    }
    return { blocks, pageCount };
  }
}

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

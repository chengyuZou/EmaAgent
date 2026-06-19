import type { DocumentBlock, DocumentPage } from '../types.js';

/**
 * Group a flat block list into pages. Blocks without a page number are
 * collected into page 0 (whole-document formats like HTML/Markdown/DOCX).
 */
export function normalizeToPages(blocks: DocumentBlock[]): DocumentPage[] {
  const pageMap = new Map<number, DocumentBlock[]>();
  for (const blk of blocks) {
    const p = blk.page ?? 0;
    const list = pageMap.get(p) ?? ([] as DocumentBlock[]);
    list.push(blk);
    pageMap.set(p, list);
  }
  return [...pageMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pageNum, blks]) => ({ pageNum, blocks: blks }));
}

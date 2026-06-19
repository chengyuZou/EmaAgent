import type { DocumentBlock } from '../types.js';

const PREVIEW_CHARS = 400;

export function extractSummary(blocks: DocumentBlock[]): string {
  return blocks
    .filter(b => b.kind !== 'title' && b.kind !== 'image')
    .map(b => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PREVIEW_CHARS);
}

export function countWords(blocks: DocumentBlock[]): number {
  return blocks
    .filter(b => b.kind !== 'image')
    .reduce((n, b) => n + b.text.split(/\s+/).filter(Boolean).length, 0);
}

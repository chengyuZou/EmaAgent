import { estimateTextTokens } from '@ema-agent/token';
import type { DocumentBlock, DocumentChunk, DocumentBlockKind } from '../types.js';
import type { Chunker, ChunkOptions } from './base.js';
import { DEFAULT_CHUNK_OPTIONS, chunkId, linkChunks } from './base.js';

// Split priority: paragraph → line → CJK sentence → Latin sentence → word
// CJK standalone punctuation separators are listed before the regex so that
// Chinese text (which uses no spaces between sentences) splits cleanly at
// full-stop characters before falling through to the look-behind regex.
const SEPARATORS = ['\n\n', '\n', '。', '！', '？', '；', '…', /(?<=[.!?])\s+/, ' '] as const;

export class RecursiveChunker implements Chunker {
  async chunk(blocks: DocumentBlock[], opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Promise<DocumentChunk[]> {
    const assetId = opts.assetId ?? 'doc';

    // Group contiguous blocks into sections by sectionPath boundary
    const sections = groupIntoSections(blocks);
    const raw: DocumentChunk[] = [];
    let idx = 0;

    for (const sec of sections) {
      const text = sec.blocks.map(b => b.markdown ?? b.text).join('\n\n').trim();
      if (!text) continue;
      const pieces = splitRecursive(text, opts.maxTokens);
      for (const piece of pieces) {
        raw.push({
          id:          chunkId(assetId, idx++),
          assetId,
          text:        piece,
          blockKinds:  collectKinds(sec.blocks),
          tokenCount:  estimateTextTokens(piece),
          page:        sec.blocks[0]?.page,
          sectionPath: sec.path,
        });
      }
    }

    const merged   = normalizeChunkSizes(raw, opts, assetId);
    const overlapped = applyOverlap(merged, opts);
    linkChunks(overlapped);
    return overlapped;
  }
}

/** Public helper so SemanticChunker can use it as fallback without a class instance. */
export function recursiveChunk(
  blocks:  DocumentBlock[],
  opts:    ChunkOptions = DEFAULT_CHUNK_OPTIONS,
  assetId: string       = 'doc',
): DocumentChunk[] {
  const sections = groupIntoSections(blocks);
  const raw: DocumentChunk[] = [];
  let idx = 0;

  for (const sec of sections) {
    const text = sec.blocks.map(b => b.markdown ?? b.text).join('\n\n').trim();
    if (!text) continue;
    const pieces = splitRecursive(text, opts.maxTokens);
    for (const piece of pieces) {
      raw.push({
        id:          chunkId(assetId, idx++),
        assetId,
        text:        piece,
        blockKinds:  collectKinds(sec.blocks),
        tokenCount:  estimateTextTokens(piece),
        page:        sec.blocks[0]?.page,
        sectionPath: sec.path,
      });
    }
  }

  const merged    = normalizeChunkSizes(raw, opts, assetId);
  const overlapped = applyOverlap(merged, opts);
  linkChunks(overlapped);
  return overlapped;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Section { path: string[]; blocks: DocumentBlock[] }

function groupIntoSections(blocks: DocumentBlock[]): Section[] {
  const secs: Section[] = [];
  let cur: Section = { path: [], blocks: [] };

  for (const b of blocks) {
    const pathKey = b.sectionPath.join('\x00');
    const curKey  = cur.path.join('\x00');
    if (pathKey !== curKey && cur.blocks.length > 0) {
      secs.push(cur);
      cur = { path: b.sectionPath, blocks: [] };
    } else if (cur.blocks.length === 0) {
      cur.path = b.sectionPath;
    }
    cur.blocks.push(b);
  }
  if (cur.blocks.length > 0) secs.push(cur);
  return secs;
}

function splitRecursive(text: string, maxTokens: number, sepIdx = 0): string[] {
  if (estimateTextTokens(text) <= maxTokens) return [text];

  const sep = SEPARATORS[sepIdx];
  if (sep === undefined) {
    // No more separators: hard-cut by approximate character ratio
    const midChar = Math.floor(text.length / 2);
    return [
      ...splitRecursive(text.slice(0, midChar), maxTokens, 0),
      ...splitRecursive(text.slice(midChar), maxTokens, 0),
    ];
  }

  const parts = typeof sep === 'string'
    ? text.split(sep)
    : text.split(sep);

  const results: string[] = [];
  let current = '';

  for (const part of parts) {
    if (!part.trim()) continue;
    const candidate = current ? current + (typeof sep === 'string' ? sep : ' ') + part : part;
    if (estimateTextTokens(candidate) <= maxTokens) {
      current = candidate;
    } else {
      if (current) results.push(...splitRecursive(current, maxTokens, sepIdx));
      current = estimateTextTokens(part) <= maxTokens ? part : '';
      if (estimateTextTokens(part) > maxTokens) {
        results.push(...splitRecursive(part, maxTokens, sepIdx + 1));
      }
    }
  }
  if (current) results.push(...splitRecursive(current, maxTokens, sepIdx));
  return results;
}

/**
 * Merge undersized tail chunks forward into their predecessor.
 * Mirrors Open WebUI's normalize_chunk_sizes — avoids orphan chunks.
 */
function normalizeChunkSizes(chunks: DocumentChunk[], opts: ChunkOptions, assetId: string): DocumentChunk[] {
  if (chunks.length === 0) return [];
  const out: DocumentChunk[] = [];
  let acc = { ...chunks[0]! };

  for (let i = 1; i < chunks.length; i++) {
    const next = chunks[i]!;
    const merged = acc.text + '\n\n' + next.text;
    if (acc.tokenCount < opts.minTokens && estimateTextTokens(merged) <= opts.maxTokens) {
      acc = { ...acc, text: merged, tokenCount: estimateTextTokens(merged) };
    } else {
      out.push(acc);
      acc = { ...next };
    }
  }
  out.push(acc);

  // Re-assign stable ids
  return out.map((c, i) => ({ ...c, id: chunkId(assetId, i) }));
}

/**
 * Prepend the last `overlap` tokens of the previous chunk to the current one.
 * This gives retrieval the context it needs to resolve cross-chunk references.
 */
function applyOverlap(chunks: DocumentChunk[], opts: ChunkOptions): DocumentChunk[] {
  if (opts.overlap <= 0 || chunks.length < 2) return chunks;
  return chunks.map((chunk, i) => {
    if (i === 0) return chunk;
    const prev = chunks[i - 1]!;
    const overlapText = takeTailTokens(prev.text, opts.overlap);
    if (!overlapText) return chunk;
    const text = overlapText + ' ' + chunk.text;
    return { ...chunk, text, tokenCount: estimateTextTokens(text) };
  });
}

function takeTailTokens(text: string, targetTokens: number): string {
  // Approximate: 1 token ≈ 4 chars for English, less for CJK
  const approxChars = targetTokens * 4;
  const tail = text.slice(-approxChars);
  // Trim to word boundary
  const spaceIdx = tail.indexOf(' ');
  return spaceIdx > 0 ? tail.slice(spaceIdx + 1) : tail;
}

function collectKinds(blocks: DocumentBlock[]): DocumentBlockKind[] {
  return [...new Set(blocks.map(b => b.kind))];
}

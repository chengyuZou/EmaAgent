import type { DocumentBlock, DocumentChunk } from '../types.js';

export interface ChunkOptions {
  maxTokens: number;   // default 512
  overlap:   number;   // default 64
  minTokens: number;   // default 20
  /** Asset id — used as prefix for chunk ids. Default 'doc'. */
  assetId?:  string;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxTokens: 512,
  overlap:   64,
  minTokens: 20,
};

export interface Chunker {
  chunk(blocks: DocumentBlock[], opts: ChunkOptions): Promise<DocumentChunk[]>;
}

export function chunkId(assetId: string, index: number): string {
  return `${assetId}-c${index}`;
}

export function linkChunks(chunks: DocumentChunk[]): void {
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0)                  chunks[i]!.prev = chunks[i - 1]!.id;
    if (i < chunks.length - 1) chunks[i]!.next = chunks[i + 1]!.id;
  }
}

/**
 * Parent-child (small-to-big) post-pass. Groups consecutive children — within
 * the same sectionPath, up to a parent token budget — into a "mom" window and
 * stamps each child with momId + momText (the window's full text).
 *
 * No separate parent rows: the parent text rides on its children (RAGFlow's
 * mom_with_weight), so FTS/embedding still index only children, while retrieval
 * can swap the matched child for its larger parent context. Single source of
 * truth — call once in ingest after the chunker returns, so every chunker
 * (recursive, semantic, …) gets consistent parents.
 */
export function assignParents(chunks: DocumentChunk[], parentMaxTokens: number): void {
  let pIdx = 0, i = 0;
  while (i < chunks.length) {
    const assetId = chunks[i]!.assetId ?? 'doc';
    const path    = chunks[i]!.sectionPath.join('\x00');
    const group: DocumentChunk[] = [];
    let tok = 0;
    while (i < chunks.length
           && chunks[i]!.sectionPath.join('\x00') === path
           && (group.length === 0 || tok + chunks[i]!.tokenCount <= parentMaxTokens)) {
      tok += chunks[i]!.tokenCount;
      group.push(chunks[i]!);
      i++;
    }
    if (group.length < 2) continue; // a lone child gains nothing from substitution
    const momId   = `${assetId}#mom${pIdx++}`;
    const momText = group.map(c => c.text).join('\n\n');
    for (const c of group) { c.momId = momId; c.momText = momText; }
  }
}

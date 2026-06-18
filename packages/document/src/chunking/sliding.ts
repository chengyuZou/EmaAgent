import { estimateTextTokens } from '@ema-agent/token';
import type { Chunk, Element } from '../types.js';
import type { Chunker, ChunkOptions } from './base.js';
import { DEFAULT_CHUNK_OPTIONS, chunkId, linkChunks } from './base.js';

/**
 * Chunker class that wraps the sliding-window strategy.
 * Intended for code-heavy or table-dense documents where semantic
 * boundaries are unclear. Implements the Chunker interface.
 */
export class SlidingChunker implements Chunker {
  async chunk(elements: Element[], opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Promise<Chunk[]> {
    return slidingChunk(elements, opts);
  }
}

/**
 * Fixed-window sliding chunker with token overlap.
 * Best suited for code files and tables where semantic boundaries are unclear.
 * The overlap ensures retrievers don't miss context split across a boundary.
 */
export function slidingChunk(
  elements: Element[],
  opts:     ChunkOptions = DEFAULT_CHUNK_OPTIONS,
  docId:    string = 'doc',
): Chunk[] {
  // Flatten everything to token-sized word segments first
  const words = elements.flatMap(el =>
    (el.markdown ?? el.text).split(/\s+/).filter(Boolean).map(w => ({ w, el })),
  );

  if (words.length === 0) return [];

  const chunks:  Chunk[] = [];
  let   start    = 0;
  let   idx      = 0;

  while (start < words.length) {
    const slice: typeof words = [];
    let   toks   = 0;
    let   end    = start;

    while (end < words.length && toks < opts.maxTokens) {
      slice.push(words[end]!);
      toks += estimateTextTokens(words[end]!.w + ' ');
      end++;
    }

    if (slice.length === 0) break;

    const text        = slice.map(s => s.w).join(' ');
    const firstEl     = slice[0]!.el;
    const elementKinds = [...new Set(slice.map(s => s.el.kind))] as Element['kind'][];

    chunks.push({
      id:           chunkId(docId, idx++),
      text,
      elementKinds,
      tokenCount:   estimateTextTokens(text),
      source: {
        fileName:    '',
        mimeType:    '',
        page:        firstEl.page,
        sectionPath: firstEl.sectionPath,
      },
    });

    // Step forward by (window - overlap), minimum 1
    const overlapWords = Math.max(1, Math.floor(opts.overlap / 4));
    start = Math.max(start + 1, end - overlapWords);
  }

  linkChunks(chunks);
  return chunks;
}

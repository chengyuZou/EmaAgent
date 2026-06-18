import type { Chunk, Element } from '../types.js';

export interface ChunkOptions {
  /** Hard token limit per chunk. Default 512. */
  maxTokens: number;
  /** Token overlap between adjacent chunks in sliding mode. Default 64. */
  overlap:   number;
  /** Chunks below this token count are merged into the next. Default 20. */
  minTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxTokens: 512,
  overlap:   64,
  minTokens: 20,
};

export interface Chunker {
  chunk(elements: Element[], opts: ChunkOptions): Promise<Chunk[]>;
}

/** Derive a stable chunk id from its position in a document. */
export function chunkId(docId: string, index: number): string {
  return `${docId}-c${index}`;
}

/** Wire prev/next links across an ordered chunk array (mutates in place). */
export function linkChunks(chunks: Chunk[]): void {
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0)                   chunks[i]!.prev = chunks[i - 1]!.id;
    if (i < chunks.length - 1)  chunks[i]!.next = chunks[i + 1]!.id;
  }
}

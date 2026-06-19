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

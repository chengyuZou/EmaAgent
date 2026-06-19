import type { DocumentBlock } from '../types.js';

export type ReaderSource =
  | { kind: 'path';  path: string }
  | { kind: 'bytes'; bytes: Uint8Array; name: string };

export interface ReadResult {
  blocks:     DocumentBlock[];
  pageCount?: number;
}

export interface DocumentReader {
  read(source: ReaderSource): Promise<ReadResult>;
}

let _nextId = 0;
export function nextBlockId(): string {
  return `blk-${(++_nextId).toString(36)}`;
}

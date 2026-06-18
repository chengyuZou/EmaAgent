import type { Element } from '../types.js';

export type ReaderSource =
  | { kind: 'path';  path: string }
  | { kind: 'bytes'; bytes: Uint8Array; name: string };

export interface DocumentReader {
  read(source: ReaderSource): Promise<Element[]>;
}

let _nextId = 0;
export function nextElementId(): string {
  return `el-${(++_nextId).toString(36)}`;
}

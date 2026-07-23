// 按 Session 保存最近读取的文件内容，供编辑安全检查和压缩后恢复使用。
import { normalize } from 'node:path';
import type { FileStateStore, FileStateStoreEntry } from './types.js';

export interface SessionFileStateEntry extends FileStateStoreEntry {
  /** 最近访问时间用于 LRU 淘汰和恢复顺序。 */
  lastAccessMs: number;
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export class SessionFileStateStore implements FileStateStore {
  private readonly entries = new Map<string, SessionFileStateEntry>();
  private totalBytes = 0;

  constructor(
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
  ) {}

  record(path: string, entry: FileStateStoreEntry): void {
    const key = normalize(path);
    const previous = this.entries.get(key);
    if (previous) {
      this.totalBytes -= byteLength(previous.content);
      this.entries.delete(key);
    }
    const stored: SessionFileStateEntry = { ...entry, lastAccessMs: Date.now() };
    this.entries.set(key, stored);
    this.totalBytes += byteLength(stored.content);
    this.evict();
  }

  get(path: string): SessionFileStateEntry | undefined {
    const key = normalize(path);
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    // 重新插入以刷新 Map 的 LRU 顺序，避免刚使用的文件被下一次淘汰。
    entry.lastAccessMs = Date.now();
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  has(path: string): boolean {
    return this.entries.has(normalize(path));
  }

  delete(path: string): void {
    const key = normalize(path);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.totalBytes -= byteLength(entry.content);
    this.entries.delete(key);
  }

  recentEntries(limit: number): ReadonlyArray<{
    path: string;
    content: string;
    mtimeMs: number;
  }> {
    return [...this.entries.entries()]
      .sort(([, left], [, right]) => right.lastAccessMs - left.lastAccessMs)
      .slice(0, limit)
      .map(([path, entry]) => ({ path, content: entry.content, mtimeMs: entry.mtimeMs }));
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    while (
      (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes)
      && this.entries.size > 0
    ) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      if (!oldest) break;
      this.totalBytes -= byteLength(oldest.content);
      this.entries.delete(oldestKey);
    }
  }
}

function byteLength(content: string): number {
  return Math.max(1, Buffer.byteLength(content, 'utf8'));
}

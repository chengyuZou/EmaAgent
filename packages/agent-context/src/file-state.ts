import { normalize } from 'node:path';
import type { IFileStateStore, IFileStateStoreEntry } from '@ema-agent/tools';

// ── AgentFileStateStore ───────────────────────────────────────────────────────
//
// Per-session cache of files the agent has read, used for two purposes:
//   1. fs_edit safety check — refuse to edit a file the agent hasn't read,
//      or whose on-disk mtime changed since the read (stale-edit guard).
//   2. post-compact restore — knows which files were recently in context so
//      the memory planner can re-inject the most relevant ones.
//
// Keys are path-normalized so "./foo.ts", "foo.ts", and "a/../foo.ts" all
// resolve to the same entry. Without this, fs_read("./x") then fs_edit("x")
// would miss the cache and the safety check would wrongly reject the edit.
//
// Bounded by entry count AND total byte size (LRU eviction). Caching file
// contents means an unbounded Map would grow without limit on long sessions.

export interface FileStateEntry extends IFileStateStoreEntry {
  /** Last access timestamp (for LRU + recency-based restore). */
  lastAccessMs: number;
}

const DEFAULT_MAX_ENTRIES    = 100;
const DEFAULT_MAX_BYTES      = 25 * 1024 * 1024; // 25 MB

export class AgentFileStateStore implements IFileStateStore {
  private readonly map = new Map<string, FileStateEntry>(); // insertion-order = LRU order
  private totalBytes = 0;

  constructor(
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly maxBytes:   number = DEFAULT_MAX_BYTES,
  ) {}

  record(path: string, entry: Omit<FileStateEntry, 'lastAccessMs'>): void {
    const key = normalize(path);
    const prev = this.map.get(key);
    if (prev) {
      this.totalBytes -= byteLen(prev.content);
      this.map.delete(key);
    }
    const full: FileStateEntry = { ...entry, lastAccessMs: Date.now() };
    this.map.set(key, full);                 // re-insert = most-recently-used
    this.totalBytes += byteLen(full.content);
    this.evict();
  }

  get(path: string): FileStateEntry | undefined {
    const key = normalize(path);
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Refresh LRU position + access time
    entry.lastAccessMs = Date.now();
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  has(path: string): boolean {
    return this.map.has(normalize(path));
  }

  delete(path: string): void {
    const key = normalize(path);
    const entry = this.map.get(key);
    if (entry) {
      this.totalBytes -= byteLen(entry.content);
      this.map.delete(key);
    }
  }

  /** Most recently accessed files first — used by post-compact restore. */
  recentPaths(limit: number): string[] {
    const entries = [...this.map.entries()]
      .sort(([, a], [, b]) => b.lastAccessMs - a.lastAccessMs);
    return entries.slice(0, limit).map(([path]) => path);
  }

  /** Full entries for the N most recently accessed files. Used by memory hooks for compact restore. */
  recentEntries(limit: number): ReadonlyArray<{ path: string; content: string; mtimeMs: number }> {
    return [...this.map.entries()]
      .sort(([, a], [, b]) => b.lastAccessMs - a.lastAccessMs)
      .slice(0, limit)
      .map(([path, entry]) => ({ path, content: entry.content, mtimeMs: entry.mtimeMs }));
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  get size(): number { return this.map.size; }

  // ── LRU eviction ──────────────────────────────────────────────────────────

  private evict(): void {
    // Evict oldest (front of Map) until both limits are satisfied.
    while (
      (this.map.size > this.maxEntries || this.totalBytes > this.maxBytes) &&
      this.map.size > 0
    ) {
      const oldestKey = this.map.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey)!;
      this.totalBytes -= byteLen(oldest.content);
      this.map.delete(oldestKey);
    }
  }
}

function byteLen(s: string): number {
  return Math.max(1, Buffer.byteLength(s, 'utf8'));
}

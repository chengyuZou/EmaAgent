import type { AlreadySurfaced } from '../types.js';

export const SURFACED_TTL_MS = 1000 * 60 * 60 * 6;   // 6 hours

export function loadSurfaced(raw: Record<string, unknown>): AlreadySurfaced {
  const entry = raw as Partial<AlreadySurfaced>;
  if (!entry.updatedAt) return { nodes: [], items: [], updatedAt: Date.now() };
  if (Date.now() - entry.updatedAt > SURFACED_TTL_MS) {
    return { nodes: [], items: [], updatedAt: Date.now() };
  }
  return {
    nodes:     Array.isArray(entry.nodes) ? entry.nodes.slice(-200) : [],
    items:     Array.isArray(entry.items) ? entry.items.slice(-200) : [],
    updatedAt: entry.updatedAt,
  };
}

export function dedupTail<T>(arr: T[], maxLen: number): T[] {
  const seen = new Set<T>();
  const out:  T[] = [];
  for (let i = arr.length - 1; i >= 0 && out.length < maxLen; i--) {
    const v = arr[i]!;
    if (seen.has(v)) continue;
    seen.add(v);
    out.unshift(v);
  }
  return out;
}

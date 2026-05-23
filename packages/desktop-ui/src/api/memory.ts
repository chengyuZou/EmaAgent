/**
 * Memory API — read-only stats + node listing for Context Window panel.
 */
import { sidecarClient } from './sidecar-client.js';

// ── Wire-format types ────────────────────────────────────────────────────────

export interface MemoryStats {
  totalNodes:    number;
  totalItems:    number;
  totalEdges:    number;
  lastIndexedAt: number | null;
  dbSizeBytes:   number;
}

export interface MemoryNode {
  id:        string;
  label:     string;
  summary:   string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryItem {
  id:        string;
  nodeId:    string;
  content:   string;
  sessionId: string | null;
  createdAt: number;
}

// ── API object ────────────────────────────────────────────────────────────────

export const memoryApi = {
  /** GET /api/memory/stats */
  async stats(): Promise<MemoryStats> {
    return sidecarClient.request<MemoryStats>('/api/memory/stats');
  },

  /** GET /api/memory/nodes */
  async listNodes(opts?: { limit?: number; cursor?: string }): Promise<MemoryNode[]> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString();
    return sidecarClient.request<MemoryNode[]>(`/api/memory/nodes${qs ? `?${qs}` : ''}`);
  },

  /** GET /api/memory/items */
  async listItems(opts?: { sessionId?: string; limit?: number }): Promise<MemoryItem[]> {
    const params = new URLSearchParams();
    if (opts?.sessionId) params.set('sessionId', opts.sessionId);
    if (opts?.limit) params.set('limit', String(opts.limit ?? 50));
    const qs = params.toString();
    return sidecarClient.request<MemoryItem[]>(`/api/memory/items${qs ? `?${qs}` : ''}`);
  },
};

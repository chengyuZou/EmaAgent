/**
 * Memory API — read-only stats + node/edge/items listing + overrides + maintenance.
 * Types imported from @ema-agent/memory and @ema-agent/storage where available.
 */
import { sidecarClient } from './sidecar-client.js';

import type {
  MemoryBackgroundHealth,
  MemoryStats,
  MemorySessionOverrides,
  MaintenanceReport,
} from '@ema-agent/memory';
import type { MemoryNodeRow, MemoryItemRow, MemoryEdgeRow } from '@ema-agent/storage';

export type {
  MemoryBackgroundHealth,
  MemoryStats,
  MemorySessionOverrides,
  MaintenanceReport,
  MemoryNodeRow,
  MemoryItemRow,
  MemoryEdgeRow,
};

export interface MemoryMaintenanceInput {
  decayAfterDays?: number;
  decayAmount?:    number;
  decayItems?:     boolean;
  dryRun?:         boolean;
}

// ── API object ────────────────────────────────────────────────────────────────

export const memoryApi = {
  /** GET /api/memory/stats */
  async stats(): Promise<MemoryStats> {
    return sidecarClient.request<MemoryStats>('/api/memory/stats');
  },

  /** GET /api/memory/health — 后台维护健康投影(idle/running/degraded,只读)。 */
  async health(): Promise<MemoryBackgroundHealth> {
    return sidecarClient.request<MemoryBackgroundHealth>('/api/memory/health');
  },

  /** GET /api/memory/nodes */
  async listNodes(opts?: {
    limit?:         number;
    nodeType?:      string;
    minImportance?: number;
    orderBy?:       string;
    search?:        string;
  }): Promise<MemoryNodeRow[]> {
    const params = new URLSearchParams();
    if (opts?.limit)         params.set('limit', String(opts.limit));
    if (opts?.nodeType)      params.set('nodeType', opts.nodeType);
    if (opts?.minImportance !== undefined) params.set('minImportance', String(opts.minImportance));
    if (opts?.orderBy)       params.set('orderBy', opts.orderBy);
    if (opts?.search)        params.set('search', opts.search);
    const qs = params.toString();
    return sidecarClient.request<MemoryNodeRow[]>(`/api/memory/nodes${qs ? `?${qs}` : ''}`);
  },

  /** GET /api/memory/items */
  async listItems(opts?: {
    limit?:         number;
    kind?:          string;
    mode?:          string;
    minImportance?: number;
    orderBy?:       string;
    search?:        string;
  }): Promise<MemoryItemRow[]> {
    const params = new URLSearchParams();
    if (opts?.limit)         params.set('limit', String(opts.limit));
    if (opts?.kind)           params.set('kind', opts.kind);
    if (opts?.mode)           params.set('mode', opts.mode);
    if (opts?.minImportance !== undefined) params.set('minImportance', String(opts.minImportance));
    if (opts?.orderBy)       params.set('orderBy', opts.orderBy);
    if (opts?.search)        params.set('search', opts.search);
    const qs = params.toString();
    return sidecarClient.request<MemoryItemRow[]>(`/api/memory/items${qs ? `?${qs}` : ''}`);
  },

  /** GET /api/memory/edges?nodes=id1,id2,... */
  async listEdges(nodeIds: string[]): Promise<MemoryEdgeRow[]> {
    return sidecarClient.request<MemoryEdgeRow[]>(
      `/api/memory/edges?nodes=${nodeIds.join(',')}`,
    );
  },

  /** GET /api/memory/sessions/:id/overrides */
  async getSessionOverrides(sessionId: string): Promise<MemorySessionOverrides> {
    return sidecarClient.request<MemorySessionOverrides>(
      `/api/memory/sessions/${sessionId}/overrides`,
    );
  },

  /** PUT /api/memory/sessions/:id/overrides */
  async setSessionOverrides(
    sessionId: string,
    overrides: MemorySessionOverrides,
  ): Promise<MemorySessionOverrides> {
    return sidecarClient.request<MemorySessionOverrides>(
      `/api/memory/sessions/${sessionId}/overrides`,
      { method: 'PUT', json: overrides },
    );
  },

  /** DELETE /api/memory/nodes/:id */
  async deleteNode(id: string): Promise<void> {
    await sidecarClient.request(`/api/memory/nodes/${id}`, { method: 'DELETE' });
  },

  /** DELETE /api/memory/items/:id */
  async deleteItem(id: string): Promise<void> {
    await sidecarClient.request(`/api/memory/items/${id}`, { method: 'DELETE' });
  },

  /** POST /api/memory/maintenance */
  async runMaintenance(input: MemoryMaintenanceInput): Promise<MaintenanceReport> {
    return sidecarClient.request<MaintenanceReport>('/api/memory/maintenance', {
      method: 'POST',
      json: input,
    });
  },
};

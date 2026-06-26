/**
 * Knowledge-base API — document ingest, list, search, maintenance.
 * Wire types defined here to avoid a frontend→backend package dependency.
 */
import { sidecarClient } from './sidecar-client.js';

// ── Wire types ────────────────────────────────────────────────────────────────

export type DocumentIndexStatus  = 'pending' | 'indexing' | 'indexed' | 'error';

export interface DocumentAssetWire {
  id:         string;
  filePath:   string;
  fileName:   string;
  mimeType:   string;
  title?:     string;
  wordCount:  number;
  pageCount?: number;
  status:     DocumentIndexStatus;
  createdAt:  number;
  updatedAt:  number;
  /** Times this KB has been selected for a turn. */
  useCount:   number;
  /** Last selection time (ms); absent → never (UI falls back to createdAt). */
  lastActivatedAt?: number;
  /** Embedding model this doc was indexed with (undefined → not embedded yet). */
  ebdModel?:  string;
  /** True when the doc's embeddings were marked stale (model changed). */
  ebdStale?:  boolean;
}

export interface ChunkSummaryWire {
  id:           string;
  text:         string;
  markdown?:    string;
  tokenCount:   number;
  page?:        number;
  sectionPath:  string[];
  hasEmbedding: boolean;
}

export interface ChunkPageWire {
  items:      ChunkSummaryWire[];
  nextCursor: number | null;
}

export interface AssetUsageWire {
  totalCalls: number;
  sessions:   Array<{ sessionId: string; title: string; calls: number }>;
}

export type KbIngestStatus = 'pending' | 'running' | 'failed';

export interface KbIngestTaskWire {
  id:        string;
  filePath:  string;
  fileName:  string;
  mimeType?: string;
  status:    KbIngestStatus;
  stage?:    string;
  progress:  number;
  error?:    string;
  createdAt: number;
  updatedAt: number;
}

/** One cursor-paginated page of KB assets. */
export interface AssetPageWire {
  items:      DocumentAssetWire[];
  nextCursor: number | null;
}

/** POST /api/kb/documents now returns immediately (202) — indexing runs in the
 *  background and progress arrives via the system SSE (kb_ingest_* events). */
export interface IngestStartedWire {
  assetId:  string;
  fileName: string;
  status:   DocumentIndexStatus;
}

export interface DocumentPreviewWire {
  assetId:   string;
  text:      string;
  pageCount?: number;
  wordCount:  number;
}

export interface KbSearchHitWire {
  chunkId:  string;
  text:     string;
  markdown?: string;
  score:    number;
  source: {
    assetId:      string;
    fileName:     string;
    page?:        number;
    sectionPath:  string[];
    chunkPreview: string;
  };
}

export interface KbSearchResultWire {
  query: string;
  hits:  KbSearchHitWire[];
}

export interface KbIngestOptions {
  ebdProviderId?:    string;
  ebdModel?:         string;
  visionProviderId?: string;
  visionModel?:      string;
  mimeType?:         string;
  /** Target KB id. Omit → active KB. */
  kbId?:             string;
}

export interface KbSearchOptions {
  /** KB ids to search. [] / omit → active KB; multiple → multi-KB merge by score. */
  kbIds?:           string[];
  /** Selected asset ids to scope search within the KB(s). */
  assetIds?:        string[];
  topK?:            number;
  alpha?:           number;
  ebdProviderId?:   string;
  ebdModel?:        string;
  rerankProviderId?: string;
  rerankModel?:      string;
}

/** One named KB library entry (from profile.db.knowledge_bases). */
export interface KbLibraryWire {
  id:        string;
  name:      string;
  path:      string;
  isActive:  boolean;
  createdAt: number;
  updatedAt: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildQs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ── API object ────────────────────────────────────────────────────────────────

export const kbApi = {
  /** POST /api/kb/documents — start background ingest, returns immediately (202). */
  async ingest(filePath: string, opts: KbIngestOptions = {}): Promise<IngestStartedWire> {
    return sidecarClient.request<IngestStartedWire>('/api/kb/documents', {
      method: 'POST',
      json: { filePath, ...opts },
    });
  },

  /** GET /api/kb/documents — cursor-paginated list (newest first), optional keyword.
   *  kbId omitted → active KB. */
  async listDocuments(opts: { cursor?: number; limit?: number; keyword?: string; kbId?: string } = {}): Promise<AssetPageWire> {
    const qs = buildQs({ cursor: opts.cursor, limit: opts.limit, keyword: opts.keyword, kbId: opts.kbId });
    return sidecarClient.request<AssetPageWire>(`/api/kb/documents${qs}`);
  },

  /** GET /api/kb/documents-stale — assets not selected in the last N days (default 30).
   *  kbId omitted → active KB. */
  async listStaleDocuments(days = 30, kbId?: string): Promise<DocumentAssetWire[]> {
    const qs = buildQs({ days, kbId });
    return sidecarClient.request<DocumentAssetWire[]>(`/api/kb/documents-stale${qs}`);
  },

  /** GET /api/kb/documents/:id — kbId omitted → active KB. */
  async getDocument(id: string, kbId?: string): Promise<DocumentAssetWire> {
    return sidecarClient.request<DocumentAssetWire>(`/api/kb/documents/${id}${buildQs({ kbId })}`);
  },

  /** GET /api/kb/documents/:id/preview — kbId omitted → active KB. */
  async getPreview(id: string, kbId?: string): Promise<DocumentPreviewWire> {
    return sidecarClient.request<DocumentPreviewWire>(`/api/kb/documents/${id}/preview${buildQs({ kbId })}`);
  },

  /** GET /api/kb/documents/:id/chunks — cursor-paginated chunk summaries.
   *  kbId omitted → active KB. */
  async listChunks(id: string, opts: { cursor?: number; limit?: number; kbId?: string } = {}): Promise<ChunkPageWire> {
    const qs = buildQs({ cursor: opts.cursor, limit: opts.limit, kbId: opts.kbId });
    return sidecarClient.request<ChunkPageWire>(`/api/kb/documents/${id}/chunks${qs}`);
  },

  /** GET /api/kb/documents/:id/usage — kbId omitted → active KB. */
  async getUsage(id: string, kbId?: string): Promise<AssetUsageWire> {
    return sidecarClient.request<AssetUsageWire>(`/api/kb/documents/${id}/usage${buildQs({ kbId })}`);
  },

  /** GET /api/kb/ingest-tasks — background ingest queue.
   *  kbId omitted → active KB. */
  async getIngestTasks(kbId?: string): Promise<KbIngestTaskWire[]> {
    return sidecarClient.request<KbIngestTaskWire[]>(`/api/kb/ingest-tasks${buildQs({ kbId })}`);
  },

  /** POST /api/kb/documents/:id/retry — re-queue a failed ingest task.
   *  kbId omitted → active KB. */
  async retryIngest(id: string, kbId?: string): Promise<void> {
    await sidecarClient.request(`/api/kb/documents/${id}/retry${buildQs({ kbId })}`, { method: 'POST' });
  },

  /** POST /api/kb/documents/:id/reembed — re-embed one doc.
   *  kbId omitted → active KB. */
  async reembedDocument(id: string, kbId?: string): Promise<void> {
    await sidecarClient.request(`/api/kb/documents/${id}/reembed${buildQs({ kbId })}`, { method: 'POST' });
  },

  /** DELETE /api/kb/documents/:id — kbId omitted → active KB. */
  async deleteDocument(id: string, kbId?: string): Promise<void> {
    await sidecarClient.request(`/api/kb/documents/${id}${buildQs({ kbId })}`, { method: 'DELETE' });
  },

  /** POST /api/kb/search — hybrid FTS + vector retrieval.
   *  opts.kbIds = [] / omit → active KB; multiple ids → cross-KB merge. */
  async search(query: string, opts: KbSearchOptions = {}): Promise<KbSearchResultWire> {
    return sidecarClient.request<KbSearchResultWire>('/api/kb/search', {
      method: 'POST',
      json: { query, ...opts },
    });
  },

  /** POST /api/kb/invalidate — mark all embeddings stale after embed model switch.
   *  kbId omitted → active KB. */
  async invalidate(newModel: string, kbId?: string): Promise<{ markedStale: number }> {
    return sidecarClient.request<{ markedStale: number }>('/api/kb/invalidate', {
      method: 'POST',
      json: { newModel, kbId },
    });
  },

  /** POST /api/kb/reembed — re-embed all stale assets in the background.
   *  kbId omitted → active KB. */
  async reembed(opts: { ebdProviderId: string; ebdModel: string; kbId?: string }): Promise<{ done: number; failed: number }> {
    return sidecarClient.request<{ done: number; failed: number }>('/api/kb/reembed', {
      method: 'POST',
      json: opts,
    });
  },

  // ── KB library registry ─────────────────────────────────────────────────────

  /** GET /api/kb/libs — list all registered KB libraries. */
  async listLibs(): Promise<KbLibraryWire[]> {
    return sidecarClient.request<KbLibraryWire[]>('/api/kb/libs');
  },

  /** POST /api/kb/libs — create a new named KB at the given folder path. */
  async createLib(name: string, kbPath: string): Promise<KbLibraryWire> {
    return sidecarClient.request<KbLibraryWire>('/api/kb/libs', {
      method: 'POST',
      json: { name, path: kbPath },
    });
  },

  /** PATCH /api/kb/libs/:id — rename a KB library. */
  async renameLib(id: string, name: string): Promise<void> {
    await sidecarClient.request(`/api/kb/libs/${id}`, {
      method: 'PATCH',
      json: { name },
    });
  },

  /** POST /api/kb/libs/:id/activate — set a KB library as the active one. */
  async activateLib(id: string): Promise<void> {
    await sidecarClient.request(`/api/kb/libs/${id}/activate`, { method: 'POST' });
  },

  /** DELETE /api/kb/libs/:id — unregister a KB (no disk deletion). */
  async deleteLib(id: string): Promise<void> {
    await sidecarClient.request(`/api/kb/libs/${id}`, { method: 'DELETE' });
  },
};

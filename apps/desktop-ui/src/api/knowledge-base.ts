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
}

/** One cursor-paginated page of KB assets. */
export interface AssetPageWire {
  items:      DocumentAssetWire[];
  nextCursor: number | null;
}

export interface IngestResultWire {
  assetId:   string;
  fileName:  string;
  chunks:    number;
  pageCount?: number;
  wordCount:  number;
  status:     DocumentIndexStatus;
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
  ebdProviderId?:  string;
  ebdModel?:       string;
  visionProviderId?: string;
  visionModel?:    string;
  mimeType?:       string;
}

export interface KbSearchOptions {
  /** Selected KB asset ids for this turn. Omit = all KBs; [] = none. */
  assetIds?:        string[];
  topK?:            number;
  alpha?:           number;
  ebdProviderId?:   string;
  ebdModel?:        string;
  rerankProviderId?: string;
  rerankModel?:      string;
}

// ── API object ────────────────────────────────────────────────────────────────

export const kbApi = {
  /** POST /api/kb/documents — ingest a file into the knowledge base. */
  async ingest(filePath: string, opts: KbIngestOptions = {}): Promise<IngestResultWire> {
    return sidecarClient.request<IngestResultWire>('/api/kb/documents', {
      method: 'POST',
      json: { filePath, ...opts },
    });
  },

  /** GET /api/kb/documents — cursor-paginated list (newest first), optional keyword. */
  async listDocuments(opts: { cursor?: number; limit?: number; keyword?: string } = {}): Promise<AssetPageWire> {
    const params = new URLSearchParams();
    if (opts.cursor !== undefined) params.set('cursor', String(opts.cursor));
    if (opts.limit  !== undefined) params.set('limit',  String(opts.limit));
    if (opts.keyword)              params.set('keyword', opts.keyword);
    const qs = params.toString();
    return sidecarClient.request<AssetPageWire>(`/api/kb/documents${qs ? `?${qs}` : ''}`);
  },

  /** GET /api/kb/documents-stale — KBs not selected in the last N days (default 30). */
  async listStaleDocuments(days = 30): Promise<DocumentAssetWire[]> {
    return sidecarClient.request<DocumentAssetWire[]>(`/api/kb/documents-stale?days=${days}`);
  },

  /** GET /api/kb/documents/:id */
  async getDocument(id: string): Promise<DocumentAssetWire> {
    return sidecarClient.request<DocumentAssetWire>(`/api/kb/documents/${id}`);
  },

  /** GET /api/kb/documents/:id/preview */
  async getPreview(id: string): Promise<DocumentPreviewWire> {
    return sidecarClient.request<DocumentPreviewWire>(`/api/kb/documents/${id}/preview`);
  },

  /** DELETE /api/kb/documents/:id */
  async deleteDocument(id: string): Promise<void> {
    await sidecarClient.request(`/api/kb/documents/${id}`, { method: 'DELETE' });
  },

  /** POST /api/kb/search — hybrid FTS + vector retrieval. */
  async search(query: string, opts: KbSearchOptions = {}): Promise<KbSearchResultWire> {
    return sidecarClient.request<KbSearchResultWire>('/api/kb/search', {
      method: 'POST',
      json: { query, ...opts },
    });
  },

  /** POST /api/kb/invalidate — mark all embeddings stale after embed model switch. */
  async invalidate(newModel: string): Promise<{ markedStale: number }> {
    return sidecarClient.request<{ markedStale: number }>('/api/kb/invalidate', {
      method: 'POST',
      json: { newModel },
    });
  },

  /** POST /api/kb/reembed — re-embed all stale assets in the background.
   *  Returns counts of assets successfully re-embedded vs failed. */
  async reembed(opts: { ebdProviderId: string; ebdModel: string }): Promise<{ done: number; failed: number }> {
    return sidecarClient.request<{ done: number; failed: number }>('/api/kb/reembed', {
      method: 'POST',
      json: opts,
    });
  },
};

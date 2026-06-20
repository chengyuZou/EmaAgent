/**
 * Knowledge-base API — document ingest, list, search, maintenance.
 * Wire types defined here to avoid a frontend→backend package dependency.
 */
import { sidecarClient } from './sidecar-client.js';

// ── Wire types ────────────────────────────────────────────────────────────────

export type DocumentScope        = 'global' | 'session';
export type DocumentIndexStatus  = 'pending' | 'indexing' | 'indexed' | 'error';

export interface DocumentAssetWire {
  id:         string;
  scope:      DocumentScope;
  sessionId?: string;
  filePath:   string;
  fileName:   string;
  mimeType:   string;
  title?:     string;
  wordCount:  number;
  pageCount?: number;
  status:     DocumentIndexStatus;
  createdAt:  number;
  updatedAt:  number;
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
  scope?:          DocumentScope;
  sessionId?:      string;
  ebdProviderId?:  string;
  ebdModel?:       string;
  visionProviderId?: string;
  visionModel?:    string;
  mimeType?:       string;
}

export interface KbSearchOptions {
  scope?:           DocumentScope;
  sessionId?:       string;
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
      json: { filePath, scope: 'global', ...opts },
    });
  },

  /** GET /api/kb/documents — list indexed assets. */
  async listDocuments(opts: { scope?: DocumentScope; sessionId?: string } = {}): Promise<DocumentAssetWire[]> {
    const params = new URLSearchParams();
    params.set('scope', opts.scope ?? 'global');
    if (opts.sessionId) params.set('sessionId', opts.sessionId);
    return sidecarClient.request<DocumentAssetWire[]>(`/api/kb/documents?${params.toString()}`);
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
      json: { query, scope: 'global', ...opts },
    });
  },

  /** POST /api/kb/invalidate — mark all embeddings stale after embed model switch. */
  async invalidate(newModel: string): Promise<{ markedStale: number }> {
    return sidecarClient.request<{ markedStale: number }>('/api/kb/invalidate', {
      method: 'POST',
      json: { newModel },
    });
  },

  /** POST /api/kb/reembed — re-embed all stale assets in the background. */
  async reembed(opts: { ebdProviderId: string; ebdModel: string }): Promise<{ reembedded: number }> {
    return sidecarClient.request<{ reembedded: number }>('/api/kb/reembed', {
      method: 'POST',
      json: opts,
    });
  },
};

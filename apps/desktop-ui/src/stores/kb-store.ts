/**
 * Knowledge-base store — document list, ingest, search.
 */
import { create } from 'zustand';
import {
  kbApi,
  type DocumentAssetWire,
  type KbSearchResultWire,
  type KbIngestOptions,
  type KbSearchOptions,
} from '../api/knowledge-base.js';

export type { DocumentAssetWire, KbSearchResultWire, KbSearchHitWire } from '../api/knowledge-base.js';

// ── Ingest job (background processing queue) ────────────────────────────────────

export type IngestStage = 'validate' | 'parse' | 'chunk' | 'embed';

export interface IngestJob {
  assetId:  string;
  fileName: string;
  stage:    IngestStage;
  progress: number;            // 0–1
  status:   'indexing' | 'done' | 'error';
  error?:   string;
}

// ── Store interface ───────────────────────────────────────────────────────────

export interface KbStoreState {
  documents:    DocumentAssetWire[];
  loading:      boolean;
  error:        string | null;

  /** assetId → in-flight ingest job (background processing queue). */
  ingestJobs:   Record<string, IngestJob>;
  ingesting:    boolean;
  ingestError:  string | null;

  searchResult:  KbSearchResultWire | null;
  searchLoading: boolean;
  searchError:   string | null;

  loadDocuments(opts?: { cursor?: number; limit?: number; keyword?: string }): Promise<void>;
  ingest(filePath: string, opts?: KbIngestOptions): Promise<void>;
  deleteDocument(id: string): Promise<void>;
  search(query: string, opts?: KbSearchOptions): Promise<void>;
  clearSearch(): void;
  clearError(): void;

  // Driven by the system SSE (kb_ingest_* events).
  onIngestProgress(assetId: string, stage: IngestStage, progress: number): void;
  onIngestCompleted(assetId: string): void;
  onIngestFailed(assetId: string, error: string): void;
  dismissJob(assetId: string): void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useKbStore = create<KbStoreState>((set, get) => ({
  documents:     [],
  loading:       false,
  error:         null,

  ingestJobs:    {},
  ingesting:     false,
  ingestError:   null,

  searchResult:  null,
  searchLoading: false,
  searchError:   null,

  async loadDocuments(opts = {}) {
    set({ loading: true, error: null });
    try {
      const page = await kbApi.listDocuments(opts);
      set({ documents: page.items, loading: false });
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : '加载文档列表失败',
        loading: false,
      });
    }
  },

  async ingest(filePath, opts = {}) {
    set({ ingesting: true, ingestError: null });
    try {
      // Background: POST returns immediately with the pre-generated assetId; a
      // processing job is shown until the system SSE delivers completion/error.
      const started = await kbApi.ingest(filePath, opts);
      set((s) => ({
        ingesting:  false,
        ingestJobs: {
          ...s.ingestJobs,
          [started.assetId]: {
            assetId:  started.assetId,
            fileName: started.fileName,
            stage:    'validate',
            progress: 0,
            status:   'indexing',
          },
        },
      }));
    } catch (err: unknown) {
      set({
        ingestError: err instanceof Error ? err.message : '导入失败',
        ingesting:   false,
      });
    }
  },

  async deleteDocument(id) {
    try {
      await kbApi.deleteDocument(id);
      set((s) => ({ documents: s.documents.filter((d) => d.id !== id) }));
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '删除失败' });
    }
  },

  async search(query, opts = {}) {
    if (!query.trim()) {
      set({ searchResult: null, searchError: null });
      return;
    }
    set({ searchLoading: true, searchError: null });
    try {
      const searchResult = await kbApi.search(query, opts);
      set({ searchResult, searchLoading: false });
    } catch (err: unknown) {
      set({
        searchError:   err instanceof Error ? err.message : '搜索失败',
        searchLoading: false,
      });
    }
  },

  clearSearch() {
    set({ searchResult: null, searchError: null });
  },

  clearError() {
    set({ error: null, ingestError: null });
  },

  onIngestProgress(assetId, stage, progress) {
    set((s) => {
      const job = s.ingestJobs[assetId];
      if (!job) return {};
      return { ingestJobs: { ...s.ingestJobs, [assetId]: { ...job, stage, progress } } };
    });
  },

  onIngestCompleted(assetId) {
    // Mark done (green, 100%) briefly so the row plays an exit animation, then
    // drop it — by which point loadDocuments has surfaced the real KB row.
    set((s) => {
      const job = s.ingestJobs[assetId];
      if (!job) return {};
      return { ingestJobs: { ...s.ingestJobs, [assetId]: { ...job, status: 'done', progress: 1 } } };
    });
    void get().loadDocuments();
    setTimeout(() => {
      set((s) => {
        const { [assetId]: _gone, ...rest } = s.ingestJobs;
        return { ingestJobs: rest };
      });
    }, 350);
  },

  onIngestFailed(assetId, error) {
    set((s) => {
      const job = s.ingestJobs[assetId];
      if (!job) return {};
      return { ingestJobs: { ...s.ingestJobs, [assetId]: { ...job, status: 'error', error } } };
    });
  },

  dismissJob(assetId) {
    set((s) => {
      const { [assetId]: _gone, ...rest } = s.ingestJobs;
      return { ingestJobs: rest };
    });
  },
}));

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

// ── Store interface ───────────────────────────────────────────────────────────

export interface KbStoreState {
  documents:    DocumentAssetWire[];
  loading:      boolean;
  error:        string | null;

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
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useKbStore = create<KbStoreState>((set, get) => ({
  documents:     [],
  loading:       false,
  error:         null,

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
      await kbApi.ingest(filePath, opts);
      // Reload the list to show the newly ingested doc.
      await get().loadDocuments();
      set({ ingesting: false });
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
}));

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
  type KbLibraryWire,
} from '../api/knowledge-base.js';

export type { DocumentAssetWire, KbSearchResultWire, KbSearchHitWire, KbLibraryWire } from '../api/knowledge-base.js';

// ── Ingest job (background processing queue) ────────────────────────────────────

export type IngestStage = 'validate' | 'parse' | 'chunk' | 'embed';
export type IngestJobStatus = 'pending' | 'running' | 'failed' | 'done';

export interface IngestJob {
  assetId:  string;
  kbId:     string;   // which KB this document belongs to
  fileName: string;
  stage?:   IngestStage;       // absent while pending
  progress: number;            // 0–1
  status:   IngestJobStatus;
  error?:   string;
}

// ── Store interface ───────────────────────────────────────────────────────────

export interface KbStoreState {
  documents:    DocumentAssetWire[];
  loading:      boolean;
  error:        string | null;

  /** assetId → in-flight ingest job (background processing queue). */
  ingestJobs:   Record<string, IngestJob>;
  /** Completed count in the current batch (done jobs are removed from the map,
   *  so this is the reliable "succeeded" tally for the nav indicator). */
  ingestDoneCount: number;
  ingesting:    boolean;
  ingestError:  string | null;

  searchResult:  KbSearchResultWire | null;
  searchLoading: boolean;
  searchError:   string | null;

  // ── KB library registry ─────────────────────────────────────────────────────
  libs:          KbLibraryWire[];
  libsLoading:   boolean;
  libsError:     string | null;

  loadDocuments(opts?: { cursor?: number; limit?: number; keyword?: string }): Promise<void>;
  loadIngestTasks(): Promise<void>;
  ingest(filePath: string, opts?: KbIngestOptions): Promise<void>;
  retryIngest(assetId: string): Promise<void>;
  deleteDocument(id: string): Promise<void>;
  search(query: string, opts?: KbSearchOptions): Promise<void>;
  clearSearch(): void;
  clearError(): void;

  // KB library operations.
  loadLibs(): Promise<void>;
  createLib(name: string, kbPath: string): Promise<KbLibraryWire | undefined>;
  renameLib(id: string, name: string): Promise<void>;
  activateLib(id: string): Promise<void>;
  deleteLib(id: string): Promise<void>;

  // Driven by the system SSE (kb_ingest_* events).
  onIngestProgress(kbId: string, assetId: string, stage: IngestStage, progress: number): void;
  onIngestCompleted(kbId: string, assetId: string): void;
  onIngestFailed(kbId: string, assetId: string, error: string): void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useKbStore = create<KbStoreState>((set, get) => ({
  documents:     [],
  loading:       false,
  error:         null,

  ingestJobs:    {},
  ingestDoneCount: 0,
  ingesting:     false,
  ingestError:   null,

  searchResult:  null,
  searchLoading: false,
  searchError:   null,

  libs:          [],
  libsLoading:   false,
  libsError:     null,

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

  async loadIngestTasks() {
    try {
      const tasks = await kbApi.getIngestTasks(); // no kbId → all KBs
      const jobs: Record<string, IngestJob> = {};
      for (const t of tasks) {
        jobs[t.id] = {
          assetId:  t.id,
          kbId:     t.kbId,
          fileName: t.fileName,
          stage:    t.stage as IngestStage | undefined,
          progress: t.progress,
          status:   t.status,
          error:    t.error,
        };
      }
      set({ ingestJobs: jobs });
    } catch { /* ignore — queue is advisory */ }
  },

  async ingest(filePath, opts = {}) {
    // Starting a fresh batch (no active jobs) → reset the succeeded tally so the
    // nav indicator counts this batch, not the last one.
    const active = Object.values(get().ingestJobs).some((j) => j.status === 'pending' || j.status === 'running');
    set({ ingesting: true, ingestError: null, ...(active ? {} : { ingestDoneCount: 0 }) });
    try {
      // Enqueue (POST returns 202 once the task row exists); hydrate the queue so
      // the new pending job shows. Progress/completion arrive via the system SSE.
      await kbApi.ingest(filePath, opts);
      await get().loadIngestTasks();
      set({ ingesting: false });
    } catch (err: unknown) {
      set({
        ingestError: err instanceof Error ? err.message : '导入失败',
        ingesting:   false,
      });
    }
  },

  async retryIngest(assetId) {
    const kbId = get().ingestJobs[assetId]?.kbId;
    // Optimistic: flip to pending immediately; the SSE drives it from there.
    set((s) => {
      const job = s.ingestJobs[assetId];
      if (!job) return {};
      return { ingestJobs: { ...s.ingestJobs, [assetId]: { ...job, status: 'pending', stage: undefined, progress: 0, error: undefined } } };
    });
    try { await kbApi.retryIngest(assetId, kbId); }
    catch { void get().loadIngestTasks(); }  // resync on failure
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

  async loadLibs() {
    set({ libsLoading: true, libsError: null });
    try {
      const libs = await kbApi.listLibs();
      set({ libs, libsLoading: false });
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '加载知识库列表失败', libsLoading: false });
    }
  },

  async createLib(name, kbPath) {
    try {
      const lib = await kbApi.createLib(name, kbPath);
      set((s) => ({ libs: [...s.libs, lib] }));
      return lib;
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '创建失败' });
      return undefined;
    }
  },

  async renameLib(id, name) {
    try {
      await kbApi.renameLib(id, name);
      set((s) => ({ libs: s.libs.map((l) => l.id === id ? { ...l, name } : l) }));
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '重命名失败' });
    }
  },

  async activateLib(id) {
    try {
      await kbApi.activateLib(id);
      set((s) => ({ libs: s.libs.map((l) => ({ ...l, isActive: l.id === id })) }));
      // Reload documents from the newly-active KB.
      void get().loadDocuments();
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '激活失败' });
    }
  },

  async deleteLib(id) {
    try {
      await kbApi.deleteLib(id);
      set((s) => ({ libs: s.libs.filter((l) => l.id !== id) }));
      // Reload documents — the deleted lib may have been active, so the
      // document list needs to reflect the new active lib (or empty).
      void get().loadDocuments();
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '删除失败' });
    }
  },

  onIngestProgress(kbId, assetId, stage, progress) {
    set((s) => {
      const job = s.ingestJobs[assetId];
      if (!job) {
        // First SSE event for this asset — create the job entry (loadIngestTasks may not have run yet).
        return { ingestJobs: { ...s.ingestJobs, [assetId]: { assetId, kbId, fileName: assetId, status: 'running', stage, progress } } };
      }
      return { ingestJobs: { ...s.ingestJobs, [assetId]: { ...job, kbId, status: 'running', stage, progress } } };
    });
  },

  onIngestCompleted(kbId, assetId) {
    // Mark done (green, 100%) briefly so the row plays an exit animation, then drop it.
    set((s) => {
      const job = s.ingestJobs[assetId];
      if (!job) return {};
      return {
        ingestDoneCount: s.ingestDoneCount + 1,
        ingestJobs: { ...s.ingestJobs, [assetId]: { ...job, kbId, status: 'done', progress: 1 } },
      };
    });
    void get().loadDocuments();
    setTimeout(() => {
      set((s) => {
        const { [assetId]: _gone, ...rest } = s.ingestJobs;
        return { ingestJobs: rest };
      });
    }, 350);
  },

  onIngestFailed(kbId, assetId, error) {
    set((s) => {
      const job = s.ingestJobs[assetId];
      if (!job) return {};
      return { ingestJobs: { ...s.ingestJobs, [assetId]: { ...job, kbId, status: 'failed', error } } };
    });
  },
}));

// ── Selectors ───────────────────────────────────────────────────────────────

export interface IngestSummary {
  active: number;   // pending + running
  failed: number;
  done:   number;   // succeeded in this batch
  total:  number;
  state:  'idle' | 'running' | 'done' | 'failed';
}

/** Aggregate ingest-queue status for the settings-nav indicator. */
export function selectIngestSummary(s: KbStoreState): IngestSummary {
  const jobs   = Object.values(s.ingestJobs);
  const active = jobs.filter((j) => j.status === 'pending' || j.status === 'running').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;
  const done   = s.ingestDoneCount;
  const total  = done + active + failed;

  let state: IngestSummary['state'] = 'idle';
  if (active > 0)            state = 'running';
  else if (total === 0)      state = 'idle';
  else if (done === 0)       state = 'failed';   // nothing succeeded → all failed
  else                       state = 'done';     // at least one succeeded, none active
  return { active, failed, done, total, state };
}

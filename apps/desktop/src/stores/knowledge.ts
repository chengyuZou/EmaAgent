/**
 * 管理知识库列表、文档导入、检索与后台重嵌入状态。
 */
import { create } from 'zustand';
import {
  knowledgeApi,
  type DocumentAsset,
  type KnowledgeSearchResult,
  type KnowledgeIngestInput,
  type KnowledgeSearchInput,
  type KnowledgeLibrary,
  type IngestTask,
} from '../api/knowledge.js';

export type { DocumentAsset, KnowledgeSearchResult, KnowledgeSearchHit, KnowledgeLibrary } from '../api/knowledge.js';

/** ingest 除文件路径外的可选参数（mimeType/kbId）。 */
export type KnowledgeIngestOptions = Omit<KnowledgeIngestInput, 'filePath'>;
/** search 除查询词外的可选参数（topK/assetIds）。 */
export type KnowledgeSearchOptions = Omit<KnowledgeSearchInput, 'query'>;

// ── Ingest job (background processing queue) ────────────────────────────────────

export type IngestStage = 'validate' | 'parse' | 'chunk' | 'embed';
export type IngestJobStatus = IngestTask['status'];

export interface IngestJob {
  taskId:   string;
  assetId:  string;
  /** HTTP 水合的任务行不带 kbId；SSE 事件到达后补齐。 */
  kbId?:    string;
  fileName: string;
  stage?:   IngestStage;       // absent while pending
  progress: number;            // 0–1
  status:   IngestJobStatus;
  error?:   string;
}

// ── Reembed task (background index rebuild; one active per KB) ──────────────────

export type ReembedTaskStatus = 'pending' | 'running' | 'failed' | 'cancelled' | 'completed';

export interface ReembedTask {
  taskId:   string;
  kbId:     string;
  /** '' = 全库扫描的终态事件。 */
  assetId:  string;
  progress: number;            // 0–1
  status:   ReembedTaskStatus;
  error?:   string;
  totalItems?: number;
  completedItems?: number;
}

// ── Store interface ───────────────────────────────────────────────────────────

export interface KbStoreState {
  documents:    DocumentAsset[];
  loading:      boolean;
  error:        string | null;

  /** assetId → in-flight ingest job (background processing queue). */
  ingestJobs:   Record<string, IngestJob>;
  /** kbId → 重建索引任务(一个 KB 同时只有一场, 新任务覆盖旧记录)。 */
  reembedTasks: Record<string, ReembedTask>;
  /** Completed count in the current batch (done jobs are removed from the map,
   *  so this is the reliable "succeeded" tally for the nav indicator). */
  ingestDoneCount: number;
  /** 当前批次已经消费的 completed asset，用于抵御 SSE 重放与重复投递。 */
  ingestCompletedAssets: Set<string>;
  ingesting:    boolean;
  ingestError:  string | null;
  ingestQueueError: string | null;

  searchResult:  KnowledgeSearchResult | null;
  searchLoading: boolean;
  searchError:   string | null;

  // ── KB library registry ─────────────────────────────────────────────────────
  libs:          KnowledgeLibrary[];
  libsLoading:   boolean;
  libsError:     string | null;

  loadDocuments(opts?: { cursor?: string; limit?: number; keyword?: string }): Promise<void>;
  loadIngestTasks(): Promise<void>;
  ingest(filePath: string, opts?: KnowledgeIngestOptions): Promise<void>;
  retryIngest(assetId: string): Promise<void>;
  deleteDocument(id: string): Promise<void>;
  search(query: string, opts?: KnowledgeSearchOptions): Promise<void>;
  clearSearch(): void;
  clearError(): void;

  // KB library operations.
  loadLibs(): Promise<void>;
  createLib(name: string, kbPath: string): Promise<KnowledgeLibrary | undefined>;
  renameLib(id: string, name: string): Promise<void>;
  activateLib(id: string): Promise<void>;
  deleteLib(id: string): Promise<void>;

  // Driven by the system SSE (kb_ingest_* events).
  onIngestProgress(kbId: string, taskId: string, assetId: string, stage: IngestStage, progress: number): void;
  onIngestCompleted(kbId: string, taskId: string, assetId: string): void;
  onIngestFailed(kbId: string, taskId: string, assetId: string, error: string): void;

  // Driven by the system SSE (kb_reembed_* events).
  onReembedProgress(kbId: string, taskId: string, assetId: string, progress: number, counts: { completed: number; total: number }): void;
  onReembedCompleted(kbId: string, taskId: string, assetId: string): void;
  onReembedCancelled(kbId: string, taskId: string, assetId: string): void;
  onReembedFailed(kbId: string, taskId: string, assetId: string, error: string): void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useKnowledgeStore = create<KbStoreState>((set, get) => ({
  documents:     [],
  loading:       false,
  error:         null,

  ingestJobs:    {},
  reembedTasks:  {},
  ingestDoneCount: 0,
  ingestCompletedAssets: new Set(),
  ingesting:     false,
  ingestError:   null,
  ingestQueueError: null,

  searchResult:  null,
  searchLoading: false,
  searchError:   null,

  libs:          [],
  libsLoading:   false,
  libsError:     null,

  async loadDocuments(opts = {}) {
    set({ loading: true, error: null });
    try {
      const page = await knowledgeApi.listDocuments(opts);
      set({ documents: [...page.items], loading: false });
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : '加载文档列表失败',
        loading: false,
      });
    }
  },

  async loadIngestTasks() {
    set({ ingestQueueError: null });
    try {
      const { items } = await knowledgeApi.listIngestTasks();
      const jobs: Record<string, IngestJob> = {};
      for (const t of items) {
        jobs[t.assetId] = {
          taskId:   t.id,
          assetId:  t.assetId,
          fileName: t.fileName,
          stage:    t.stage as IngestStage | undefined,
          progress: t.progress,
          status:   t.status,
          error:    t.error,
        };
      }
      set({ ingestJobs: jobs, ingestQueueError: null });
    } catch (error: unknown) {
      // 队列刷新失败时保留旧快照；它可能过期，但不能伪装成“没有后台任务”。
      set({
        ingestQueueError: error instanceof Error ? error.message : '加载知识库任务队列失败',
      });
    }
  },

  async ingest(filePath, opts = {}) {
    // Starting a fresh batch (no active jobs) → reset the succeeded tally so the
    // nav indicator counts this batch, not the last one.
    const active = Object.values(get().ingestJobs).some((j) => j.status === 'pending' || j.status === 'running');
    set({
      ingesting: true,
      ingestError: null,
      ...(active ? {} : { ingestDoneCount: 0, ingestCompletedAssets: new Set<string>() }),
    });
    try {
      // Enqueue (POST returns 202 once the task row exists); hydrate the queue so
      // the new pending job shows. Progress/completion arrive via the system SSE.
      await knowledgeApi.ingest({ filePath, ...opts });
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
    const job = get().ingestJobs[assetId];
    // Optimistic: flip to pending immediately; the SSE drives it from there.
    set((s) => {
      const current = s.ingestJobs[assetId];
      if (!current) return {};
      return { ingestJobs: { ...s.ingestJobs, [assetId]: { ...current, status: 'pending', stage: undefined, progress: 0, error: undefined } } };
    });
    try { await knowledgeApi.retryIngest(job?.taskId ?? assetId, job?.kbId); }
    catch { void get().loadIngestTasks(); }  // resync on failure
  },

  async deleteDocument(id) {
    try {
      await knowledgeApi.deleteDocument(id);
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
      const searchResult = await knowledgeApi.search({ query, ...opts });
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
      const { items } = await knowledgeApi.listLibs();
      set({ libs: [...items], libsLoading: false });
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '加载知识库列表失败', libsLoading: false });
    }
  },

  async createLib(name, kbPath) {
    try {
      const lib = await knowledgeApi.createLib(name, kbPath);
      set((s) => ({ libs: [...s.libs, lib] }));
      return lib;
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '创建失败' });
      return undefined;
    }
  },

  async renameLib(id, name) {
    try {
      await knowledgeApi.renameLib(id, name);
      set((s) => ({ libs: s.libs.map((l) => l.id === id ? { ...l, name } : l) }));
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '重命名失败' });
    }
  },

  async activateLib(id) {
    try {
      await knowledgeApi.activateLib(id);
      set((s) => ({ libs: s.libs.map((l) => ({ ...l, isActive: l.id === id })) }));
      // Reload documents from the newly-active KB.
      void get().loadDocuments();
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '激活失败' });
    }
  },

  async deleteLib(id) {
    try {
      await knowledgeApi.deleteLib(id);
      set((s) => ({ libs: s.libs.filter((l) => l.id !== id) }));
      // Reload documents — the deleted lib may have been active, so the
      // document list needs to reflect the new active lib (or empty).
      void get().loadDocuments();
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '删除失败' });
    }
  },

  onIngestProgress(kbId, taskId, assetId, stage, progress) {
    set((s) => {
      const job = s.ingestJobs[assetId];
      if (!job) {
        // First SSE event for this asset — create the job entry (loadIngestTasks may not have run yet).
        return { ingestJobs: { ...s.ingestJobs, [assetId]: { taskId, assetId, kbId, fileName: assetId, status: 'running', stage, progress } } };
      }
      return { ingestJobs: { ...s.ingestJobs, [assetId]: { ...job, taskId, kbId, status: 'running', stage, progress } } };
    });
  },

  onIngestCompleted(kbId, taskId, assetId) {
    // Mark done (green, 100%) briefly so the row plays an exit animation, then drop it.
    set((s) => {
      // SSE 可能早于 HTTP 队列水合到达；终态事件本身足以建立最小可信记录。
      const job = s.ingestJobs[assetId] ?? {
        taskId,
        assetId,
        kbId,
        fileName: assetId,
        status: 'completed' as const,
        progress: 1,
      };
      const completedAssets = new Set(s.ingestCompletedAssets);
      const firstCompletion = !completedAssets.has(assetId);
      completedAssets.add(assetId);
      return {
        ingestDoneCount: s.ingestDoneCount + (firstCompletion ? 1 : 0),
        ingestCompletedAssets: completedAssets,
        ingestJobs: { ...s.ingestJobs, [assetId]: { ...job, taskId, kbId, status: 'completed', progress: 1 } },
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

  onIngestFailed(kbId, taskId, assetId, error) {
    set((s) => {
      const job = s.ingestJobs[assetId];
      if (!job) return {};
      return { ingestJobs: { ...s.ingestJobs, [assetId]: { ...job, taskId, kbId, status: 'failed', error } } };
    });
  },

  onReembedProgress(kbId, taskId, assetId, progress, counts) {
    set((s) => ({
      reembedTasks: {
        ...s.reembedTasks,
        [kbId]: {
          taskId,
          kbId,
          assetId,
          progress,
          status: 'running',
          totalItems: counts.total,
          completedItems: counts.completed,
        },
      },
    }));
  },

  onReembedCompleted(kbId, taskId, assetId) {
    set((s) => {
      const job = s.reembedTasks[kbId];
      if (!job) return {};
      return {
        reembedTasks: {
          ...s.reembedTasks,
          [kbId]: {
            ...job,
            taskId,
            assetId,
            status: 'completed',
            progress: 1,
          },
        },
      };
    });
    void get().loadDocuments();
  },

  onReembedCancelled(kbId, taskId, assetId) {
    set((s) => {
      const job = s.reembedTasks[kbId];
      const base: ReembedTask = job ?? {
        taskId,
        kbId,
        assetId,
        progress: 0,
        status: 'cancelled',
      };
      return {
        reembedTasks: {
          ...s.reembedTasks,
          [kbId]: {
            ...base,
            taskId,
            status: 'cancelled',
          },
        },
      };
    });
  },

  onReembedFailed(kbId, taskId, assetId, error) {
    set((s) => {
      const job = s.reembedTasks[kbId];
      const base: ReembedTask = job ?? {
        taskId,
        kbId,
        assetId,
        progress: 0,
        status: 'failed',
      };
      return { reembedTasks: { ...s.reembedTasks, [kbId]: { ...base, taskId, status: 'failed', error } } };
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

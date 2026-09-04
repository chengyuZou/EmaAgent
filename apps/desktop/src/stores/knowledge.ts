// 知识库数据入口：库注册表、文档资产、摄入/重嵌任务与检索结果。
// 设置页按"正在查看的库"(viewingKbId)工作;Agent 检索目标库由激活状态决定,两者互不干扰。
// 任务状态全部保存 Route 原生任务行与原始 kb_* 系统事件，不做字段改名或二次聚合。
import { create } from 'zustand';
import {
  knowledgeApi,
  type DocumentAsset,
  type IngestTaskList,
  type KnowledgeIngestInput,
  type KnowledgeLibrary,
  type KnowledgeLibraryCreated,
  type KnowledgeSearchInput,
  type KnowledgeSearchResult,
  type ReembedTaskList,
} from '../api/knowledge.js';
import type { AppEvent } from '@ema-agent/server/sse/eventHub.js';

/** Route 原生摄入任务行（HTTP 水合与 SSE 进度更新共用同一形状）。 */
type IngestTaskRow = IngestTaskList['items'][number];
/** Route 原生重嵌任务行。 */
type ReembedTaskRow = ReembedTaskList['items'][number];
/** kb_ingest_* / kb_reembed_* 系统事件（KnowledgeEvent 经 AppEvent 联合原样携带）。 */
type KnowledgeDomainEvent = Extract<AppEvent, { type: `kb_${string}` }>;

export interface KnowledgeStoreState {
  /** 设置页正在查看的库;文档/任务/检索都以它为目标。 */
  viewingKbId: string | null;
  documents:    DocumentAsset[];
  loading:      boolean;
  error:        string | null;

  /** assetId → Route 原生摄入任务行（仅 viewingKbId 库）；进度由 kb_ingest_* SSE 原位更新。 */
  ingestTasks:  Record<string, IngestTaskRow>;
  /** taskId → Route 原生重嵌任务行（仅 viewingKbId 库）。 */
  reembedTasks: Record<string, ReembedTaskRow>;
  /** 当前批次已成功数（完成行会退出动画后移除，导航指示器靠它计数）。 */
  ingestDoneCount: number;
  /** 已计数的 completed asset，抵御 SSE 重放与重复投递。 */
  ingestCompletedAssets: Set<string>;
  ingesting:    boolean;
  ingestError:  string | null;
  ingestQueueError: string | null;

  searchResult:  KnowledgeSearchResult | null;
  searchLoading: boolean;
  searchError:   string | null;

  libs:          KnowledgeLibrary[];
  libsLoading:   boolean;
  libsError:     string | null;

  setViewingKb(kbId: string | null): void;
  loadDocuments(opts?: { cursor?: string; limit?: number; keyword?: string }): Promise<void>;
  loadIngestTasks(): Promise<void>;
  loadReembedTasks(): Promise<void>;
  ingest(input: KnowledgeIngestInput): Promise<void>;
  retryIngest(assetId: string): Promise<void>;
  cancelIngest(taskId: string): Promise<void>;
  deleteIngestTask(taskId: string): Promise<void>;
  deleteDocument(id: string): Promise<void>;
  search(input: KnowledgeSearchInput): Promise<void>;
  clearSearch(): void;
  clearError(): void;

  loadLibs(): Promise<void>;
  createLib(name: string, parentPath: string): Promise<KnowledgeLibraryCreated | undefined>;
  renameLib(id: string, name: string): Promise<void>;
  activateLib(id: string): Promise<void>;
  deleteLib(id: string): Promise<void>;

  /** 整库重建过期索引：取 stale 清单整单入队；返回提交资产数，0 = 无需重建。 */
  submitReembedStale(): Promise<number>;
  retryReembed(taskId: string): Promise<void>;
  cancelReembed(taskId: string): Promise<void>;
  deleteReembedTask(taskId: string): Promise<void>;

  /** 系统 SSE 唯一入口：按事件类型原位更新任务行;库计数始终刷新。 */
  applyKnowledgeEvent(event: KnowledgeDomainEvent): void;
}

export const useKnowledgeStore = create<KnowledgeStoreState>((set, get) => ({
  viewingKbId:   null,
  documents:     [],
  loading:       false,
  error:         null,

  ingestTasks:   {},
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

  setViewingKb(kbId) {
    if (get().viewingKbId === kbId) return;
    // 换查看目标：旧库的任务行/文档全部撤下,再从新区水合。
    set({
      viewingKbId: kbId,
      documents: [],
      ingestTasks: {},
      reembedTasks: {},
      searchResult: null,
      searchError: null,
      error: null,
      ingestError: null,
      ingestQueueError: null,
    });
    if (kbId) {
      void get().loadDocuments();
      void get().loadIngestTasks();
      void get().loadReembedTasks();
    }
  },

  async loadDocuments(opts = {}) {
    const kbId = get().viewingKbId;
    if (!kbId) { set({ documents: [], loading: false }); return; }
    set({ loading: true, error: null });
    try {
      const page = await knowledgeApi.listDocuments(kbId, opts);
      // 加载期间用户换了查看库,结果作废,不写回。
      if (get().viewingKbId !== kbId) return;
      set({ documents: [...page.items], loading: false });
    } catch (err: unknown) {
      if (get().viewingKbId !== kbId) return;
      set({
        error: err instanceof Error ? err.message : '加载文档列表失败',
        loading: false,
      });
    }
  },

  async loadIngestTasks() {
    const kbId = get().viewingKbId;
    if (!kbId) { set({ ingestTasks: {} }); return; }
    set({ ingestQueueError: null });
    try {
      const { items } = await knowledgeApi.listIngestTasks(kbId);
      if (get().viewingKbId !== kbId) return;
      const tasks: Record<string, IngestTaskRow> = {};
      for (const row of items) tasks[row.assetId] = row;
      set({ ingestTasks: tasks, ingestQueueError: null });
    } catch (error: unknown) {
      // 队列刷新失败时保留旧数据；它可能过期，但不能伪装成“没有后台任务”。
      set({
        ingestQueueError: error instanceof Error ? error.message : '加载知识库任务队列失败',
      });
    }
  },

  async loadReembedTasks() {
    const kbId = get().viewingKbId;
    if (!kbId) { set({ reembedTasks: {} }); return; }
    try {
      const { items } = await knowledgeApi.listReembedTasks(kbId);
      if (get().viewingKbId !== kbId) return;
      const tasks: Record<string, ReembedTaskRow> = {};
      for (const row of items) tasks[row.id] = row;
      set({ reembedTasks: tasks });
    } catch {
      // 重嵌任务行是辅助展示,失败静默保留旧值。
    }
  },

  async ingest(input) {
    const kbId = get().viewingKbId;
    if (!kbId) return;
    // 开始新批次（无活跃任务）时重置成功计数，导航指示器只统计本批次。
    const active = Object.values(get().ingestTasks).some(
      (t) => t.status === 'pending' || t.status === 'running',
    );
    set({
      ingesting: true,
      ingestError: null,
      ...(active ? {} : { ingestDoneCount: 0, ingestCompletedAssets: new Set<string>() }),
    });
    try {
      // 入队（202 返回任务行）后水合队列让新 pending 行出现；进度/终态由系统 SSE 驱动。
      await knowledgeApi.ingest(kbId, input);
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
    const kbId = get().viewingKbId;
    const row = get().ingestTasks[assetId];
    if (!kbId || !row) return;
    // 乐观翻回 pending；后续进度由 SSE 驱动，失败则整队重水合。
    set((s) => ({
      ingestTasks: {
        ...s.ingestTasks,
        [assetId]: { ...row, status: 'pending', stage: undefined, progress: 0, error: undefined },
      },
    }));
    try { await knowledgeApi.retryIngest(kbId, row.id); }
    catch { void get().loadIngestTasks(); }
  },

  async cancelIngest(taskId) {
    const kbId = get().viewingKbId;
    if (!kbId) return;
    await knowledgeApi.cancelIngest(kbId, taskId);
  },

  async deleteIngestTask(taskId) {
    const kbId = get().viewingKbId;
    if (!kbId) return;
    await knowledgeApi.deleteIngestTask(kbId, taskId);
    set((s) => {
      const rest = Object.fromEntries(
        Object.entries(s.ingestTasks).filter(([, row]) => row.id !== taskId),
      );
      return { ingestTasks: rest };
    });
  },

  async deleteDocument(id) {
    const kbId = get().viewingKbId;
    if (!kbId) return;
    try {
      await knowledgeApi.deleteDocument(kbId, id);
      set((s) => ({ documents: s.documents.filter((d) => d.id !== id) }));
      void get().loadLibs();   // 库卡文档计数跟随刷新
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '删除失败' });
    }
  },

  async search(input) {
    const kbId = get().viewingKbId;
    if (!kbId) return;
    if (!input.query.trim()) {
      set({ searchResult: null, searchError: null });
      return;
    }
    set({ searchLoading: true, searchError: null });
    try {
      const searchResult = await knowledgeApi.search(kbId, input);
      if (get().viewingKbId !== kbId) return;
      set({ searchResult, searchLoading: false });
    } catch (err: unknown) {
      if (get().viewingKbId !== kbId) return;
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

  async createLib(name, parentPath) {
    try {
      const lib = await knowledgeApi.createLib(name, parentPath);
      // 新库没有文档与任务,计数恒零,本地补齐与列表投影同形。
      set((s) => ({
        libs: [...s.libs, { ...lib, documentCount: 0, readyCount: 0, staleCount: 0, activeTaskCount: 0 }],
      }));
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
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '激活失败' });
    }
  },

  async deleteLib(id) {
    try {
      await knowledgeApi.deleteLib(id);
      set((s) => ({ libs: s.libs.filter((l) => l.id !== id) }));
      // 被删的可能是正在查看的库：查看目标与文档列表一起撤下。
      if (get().viewingKbId === id) get().setViewingKb(null);
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '删除失败' });
    }
  },

  async submitReembedStale() {
    const kbId = get().viewingKbId;
    if (!kbId) return 0;
    const stale = await knowledgeApi.listStaleAssets(kbId);
    if (stale.items.length === 0) return 0;
    await knowledgeApi.reembed(kbId, { assetIds: [...stale.items] });
    void get().loadReembedTasks();
    return stale.items.length;
  },

  async retryReembed(taskId) {
    const kbId = get().viewingKbId;
    if (!kbId) return;
    await knowledgeApi.retryReembed(kbId, taskId);
    void get().loadReembedTasks();
  },

  async cancelReembed(taskId) {
    const kbId = get().viewingKbId;
    if (!kbId) return;
    await knowledgeApi.cancelReembed(kbId, taskId);
  },

  async deleteReembedTask(taskId) {
    const kbId = get().viewingKbId;
    if (!kbId) return;
    await knowledgeApi.deleteReembedTask(kbId, taskId);
    set((s) => {
      const rest = { ...s.reembedTasks };
      delete rest[taskId];
      return { reembedTasks: rest };
    });
  },

  applyKnowledgeEvent(event) {
    // 库卡计数(文档数/在途任务数)任何库的事件都触发一次轻量刷新。
    void get().loadLibs();
    // 任务行/文档只跟随正在查看的库。
    if (event.kbId !== get().viewingKbId) return;
    switch (event.type) {
      case 'kb_ingest_progress': {
        const row = get().ingestTasks[event.assetId];
        if (!row) {
          // SSE 早于 HTTP 水合到达：任务行在服务端已持久化，直接整队重水合。
          void get().loadIngestTasks();
          return;
        }
        set((s) => ({
          ingestTasks: {
            ...s.ingestTasks,
            [event.assetId]: { ...row, status: 'running', stage: event.stage, progress: event.progress },
          },
        }));
        return;
      }

      case 'kb_ingest_completed': {
        set((s) => {
          const completedAssets = new Set(s.ingestCompletedAssets);
          const firstCompletion = !completedAssets.has(event.assetId);
          completedAssets.add(event.assetId);
          const row = s.ingestTasks[event.assetId];
          return {
            ingestDoneCount: s.ingestDoneCount + (firstCompletion ? 1 : 0),
            ingestCompletedAssets: completedAssets,
            ...(row
              ? { ingestTasks: { ...s.ingestTasks, [event.assetId]: { ...row, status: 'completed' as const, progress: 1 } } }
              : {}),
          };
        });
        // 行短暂停留播退出动画后移除；文档列表刷新拿到 ready 状态。
        setTimeout(() => {
          set((s) => {
            const rest = { ...s.ingestTasks };
            delete rest[event.assetId];
            return { ingestTasks: rest };
          });
        }, 350);
        void get().loadDocuments();
        return;
      }

      case 'kb_ingest_failed': {
        const row = get().ingestTasks[event.assetId];
        if (!row) {
          void get().loadIngestTasks();
          return;
        }
        set((s) => ({
          ingestTasks: {
            ...s.ingestTasks,
            [event.assetId]: { ...row, status: 'failed', error: event.error },
          },
        }));
        return;
      }

      case 'kb_ingest_cancelled': {
        const row = get().ingestTasks[event.assetId];
        if (!row) {
          void get().loadIngestTasks();
          return;
        }
        set((s) => ({
          ingestTasks: {
            ...s.ingestTasks,
            [event.assetId]: { ...row, status: 'cancelled' },
          },
        }));
        return;
      }

      case 'kb_reembed_progress': {
        const row = get().reembedTasks[event.taskId];
        if (!row) {
          void get().loadReembedTasks();
          return;
        }
        set((s) => ({
          reembedTasks: {
            ...s.reembedTasks,
            [event.taskId]: { ...row, status: 'running', progress: event.progress },
          },
        }));
        return;
      }

      case 'kb_reembed_completed':
      case 'kb_reembed_cancelled':
      case 'kb_reembed_failed':
        void get().loadReembedTasks();
        void get().loadDocuments();
        return;
    }
  },
}));

// ── 选择器 ───────────────────────────────────────────────────────────────────

export interface IngestSummary {
  active: number;   // pending + running
  failed: number;
  done:   number;   // 本批次已成功
  total:  number;
  state:  'idle' | 'running' | 'done' | 'failed';
}

/** 设置导航指示器的摄入队列聚合(正在查看的库)。 */
export function selectIngestSummary(s: KnowledgeStoreState): IngestSummary {
  const rows   = Object.values(s.ingestTasks);
  const active = rows.filter((t) => t.status === 'pending' || t.status === 'running').length;
  const failed = rows.filter((t) => t.status === 'failed').length;
  const done   = s.ingestDoneCount;
  const total  = done + active + failed;

  let state: IngestSummary['state'] = 'idle';
  if (active > 0)            state = 'running';
  else if (total === 0)      state = 'idle';
  else if (done === 0)       state = 'failed';   // 无一成功 → 全部失败
  else                       state = 'done';     // 至少一个成功且无活跃
  return { active, failed, done, total, state };
}

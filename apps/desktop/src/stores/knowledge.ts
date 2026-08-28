// 知识库数据入口：库注册表、文档资产、摄入/重嵌任务与检索结果。
// 任务状态全部保存 Route 原生任务行与原始 kb_* 系统事件，不做字段改名或二次聚合。
import { create } from 'zustand';
import {
  knowledgeApi,
  type DocumentAsset,
  type IngestTaskList,
  type KnowledgeIngestInput,
  type KnowledgeLibrary,
  type KnowledgeSearchInput,
  type KnowledgeSearchResult,
} from '../api/knowledge.js';
import type { AppEvent } from '@ema-agent/server/sse/eventHub.js';

/** Route 原生摄入任务行（HTTP 水合与 SSE 进度更新共用同一形状）。 */
type IngestTaskRow = IngestTaskList['items'][number];
/** kb_ingest_* / kb_reembed_* 系统事件（KnowledgeEvent 经 AppEvent 联合原样携带）。 */
type KnowledgeDomainEvent = Extract<AppEvent, { type: `kb_${string}` }>;
/** 每 KB 重建卡片消费的最新一条 kb_reembed_* 事件。 */
type ReembedEvent = Extract<AppEvent, { type: `kb_reembed_${string}` }>;

export interface KnowledgeStoreState {
  documents:    DocumentAsset[];
  loading:      boolean;
  error:        string | null;

  /** assetId → Route 原生摄入任务行；进度由 kb_ingest_* SSE 原位更新。 */
  ingestTasks:  Record<string, IngestTaskRow>;
  /** 当前批次已成功数（完成行会退出动画后移除，导航指示器靠它计数）。 */
  ingestDoneCount: number;
  /** 已计数的 completed asset，抵御 SSE 重放与重复投递。 */
  ingestCompletedAssets: Set<string>;
  ingesting:    boolean;
  ingestError:  string | null;
  ingestQueueError: string | null;

  /** kbId → 最近一条 kb_reembed_* 原始事件；一个 KB 同时只有一场重建。 */
  reembedEvents: Record<string, ReembedEvent>;

  searchResult:  KnowledgeSearchResult | null;
  searchLoading: boolean;
  searchError:   string | null;

  libs:          KnowledgeLibrary[];
  libsLoading:   boolean;
  libsError:     string | null;

  loadDocuments(opts?: { cursor?: string; limit?: number; keyword?: string }): Promise<void>;
  loadIngestTasks(): Promise<void>;
  ingest(input: KnowledgeIngestInput): Promise<void>;
  retryIngest(assetId: string): Promise<void>;
  deleteDocument(id: string): Promise<void>;
  search(input: KnowledgeSearchInput): Promise<void>;
  clearSearch(): void;
  clearError(): void;

  loadLibs(): Promise<void>;
  createLib(name: string, kbPath: string): Promise<KnowledgeLibrary | undefined>;
  renameLib(id: string, name: string): Promise<void>;
  activateLib(id: string): Promise<void>;
  deleteLib(id: string): Promise<void>;

  /** 整库重建过期索引：取 stale 清单整单入队；返回提交资产数，0 = 无需重建。 */
  submitReembedStale(): Promise<number>;
  cancelReembed(taskId: string): Promise<void>;

  /** 系统 SSE 唯一入口：按事件类型原位更新任务行/重建卡片。 */
  applyKnowledgeEvent(event: KnowledgeDomainEvent): void;
}

export const useKnowledgeStore = create<KnowledgeStoreState>((set, get) => ({
  documents:     [],
  loading:       false,
  error:         null,

  ingestTasks:   {},
  ingestDoneCount: 0,
  ingestCompletedAssets: new Set(),
  ingesting:     false,
  ingestError:   null,
  ingestQueueError: null,

  reembedEvents: {},

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

  async ingest(input) {
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
      await knowledgeApi.ingest(input);
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
    const row = get().ingestTasks[assetId];
    if (!row) return;
    // 乐观翻回 pending；后续进度由 SSE 驱动，失败则整队重水合。
    set((s) => ({
      ingestTasks: {
        ...s.ingestTasks,
        [assetId]: { ...row, status: 'pending', stage: undefined, progress: 0, error: undefined },
      },
    }));
    try { await knowledgeApi.retryIngest(row.id); }
    catch { void get().loadIngestTasks(); }
  },

  async deleteDocument(id) {
    try {
      await knowledgeApi.deleteDocument(id);
      set((s) => ({ documents: s.documents.filter((d) => d.id !== id) }));
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '删除失败' });
    }
  },

  async search(input) {
    if (!input.query.trim()) {
      set({ searchResult: null, searchError: null });
      return;
    }
    set({ searchLoading: true, searchError: null });
    try {
      const searchResult = await knowledgeApi.search(input);
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
      // 换库后文档与任务队列都指向新的活跃库。
      void get().loadDocuments();
      void get().loadIngestTasks();
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '激活失败' });
    }
  },

  async deleteLib(id) {
    try {
      await knowledgeApi.deleteLib(id);
      set((s) => ({ libs: s.libs.filter((l) => l.id !== id) }));
      // 被删的可能是活跃库：文档列表与任务队列跟随新的活跃库（或清空）。
      void get().loadDocuments();
      void get().loadIngestTasks();
    } catch (err: unknown) {
      set({ libsError: err instanceof Error ? err.message : '删除失败' });
    }
  },

  async submitReembedStale() {
    // V1 不传 kbId：Route 缺省解析当前活跃库。
    const stale = await knowledgeApi.listStaleAssets();
    if (stale.items.length === 0) return 0;
    await knowledgeApi.reembed({ assetIds: [...stale.items] });
    // 入队成功即清掉同库上一场重建的终态卡片，新进度事件随后覆盖。
    const activeId = get().libs.find((l) => l.isActive)?.id;
    if (activeId) {
      set((s) => {
        const rest = { ...s.reembedEvents };
        delete rest[activeId];
        return { reembedEvents: rest };
      });
    }
    return stale.items.length;
  },

  async cancelReembed(taskId) {
    await knowledgeApi.cancelReembed(taskId);
  },

  applyKnowledgeEvent(event) {
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

      case 'kb_reembed_progress':
      case 'kb_reembed_cancelled':
      case 'kb_reembed_failed':
        set((s) => ({ reembedEvents: { ...s.reembedEvents, [event.kbId]: event } }));
        return;

      case 'kb_reembed_completed':
        set((s) => ({ reembedEvents: { ...s.reembedEvents, [event.kbId]: event } }));
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

/** 设置导航指示器的摄入队列聚合。 */
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

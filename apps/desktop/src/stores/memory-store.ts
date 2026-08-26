// 管理通用记忆的存储状态、后台任务（提取/整合/维护 Job）与记忆文件浏览/搜索。
// 旧图模型（nodes/items/edges/overrides/health）已随 Memory 双轨重构删除，无对应链路。
import { create } from 'zustand';
import {
  memoryApi,
  type MemoryStats,
  type MemoryJob,
  type MemoryJobPaths,
  type MemoryFileList,
  type MemoryFileContent,
  type MemorySearchInput,
  type MemorySearchResult,
  type MemoryConsolidateInput,
  type MemoryMaintenanceInput,
} from '../api/memory.js';

// ── Store interface ───────────────────────────────────────────────────────────

export interface MemoryStoreState {
  /** 记忆存储状态（字节/限量/水位）；null = 尚未拉取。 */
  stats:        MemoryStats | null;
  statsLoading: boolean;
  statsError:   string | null;

  /** 最近后台任务快照；null = 尚未拉取。Job 状态以 SQL 为事实源，按需刷新。 */
  jobs:         MemoryJob[] | null;
  jobsLoading:  boolean;
  jobsError:    string | null;

  refreshStats(): Promise<void>;
  refreshJobs(limit?: number): Promise<void>;

  /** 只有 failed 可重试；重试复制一条新 pending，原行保留为失败记录。 */
  retryJob(id: string): Promise<void>;
  cancelJob(id: string): Promise<void>;
  /** 任务涉及的记忆路径（按需读取，不缓存）。 */
  loadJobPaths(id: string): Promise<MemoryJobPaths>;

  /** 入队整合 Job（202）；状态经 refreshJobs 观察。 */
  consolidate(kind: MemoryConsolidateInput['kind']): Promise<void>;
  /** 入队维护 Job（202）；clear_memory/storage_cleanup 会改变存储占用。 */
  maintenance(kind: MemoryMaintenanceInput['kind']): Promise<void>;

  // ── 记忆文件浏览/搜索（按需读取，不缓存） ─────────────────────────────────

  listFiles(opts?: { path?: string; cursor?: string; maxResults?: number }): Promise<MemoryFileList>;
  readFile(opts: { path: string; lineOffset?: number; maxLines?: number }): Promise<MemoryFileContent>;
  searchFiles(input: MemorySearchInput): Promise<MemorySearchResult>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useMemoryStore = create<MemoryStoreState>((set, get) => ({
  stats:        null,
  statsLoading: false,
  statsError:   null,
  jobs:         null,
  jobsLoading:  false,
  jobsError:    null,

  async refreshStats() {
    if (get().statsLoading) return;
    set({ statsLoading: true, statsError: null });
    try {
      const stats = await memoryApi.stats();
      set({ stats, statsLoading: false, statsError: null });
    } catch (error: unknown) {
      set({
        statsLoading: false,
        statsError: error instanceof Error ? error.message : '加载记忆统计失败',
      });
    }
  },

  async refreshJobs(limit) {
    if (get().jobsLoading) return;
    set({ jobsLoading: true, jobsError: null });
    try {
      const { items } = await memoryApi.listJobs(limit);
      set({ jobs: [...items], jobsLoading: false, jobsError: null });
    } catch (error: unknown) {
      set({
        jobsLoading: false,
        jobsError: error instanceof Error ? error.message : '加载记忆任务失败',
      });
    }
  },

  async retryJob(id) {
    await memoryApi.retryJob(id);
    await get().refreshJobs();
  },

  async cancelJob(id) {
    await memoryApi.cancelJob(id);
    await get().refreshJobs();
  },

  loadJobPaths(id) {
    return memoryApi.listJobPaths(id);
  },

  async consolidate(kind) {
    await memoryApi.consolidate(kind);
    await get().refreshJobs();
  },

  async maintenance(kind) {
    await memoryApi.maintenance(kind);
    await get().refreshJobs();
    // 维护会清除或回收存储，统计快照已过期。
    void get().refreshStats();
  },

  listFiles(opts) {
    return memoryApi.listFiles(opts);
  },

  readFile(opts) {
    return memoryApi.readFile(opts);
  },

  searchFiles(input) {
    return memoryApi.search(input);
  },
}));

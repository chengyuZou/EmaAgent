// 存储域状态(单库化):库统计 + Session 摘要列表 + 加载态。
// 数据目录只有一个；进入页面及跨窗口持久数据变化后重新查询。
import { create } from 'zustand';
import { systemApi, type DataDirStats, type SessionSummary } from '../api/system.js';

interface StorageStoreState {
  stats: DataDirStats | null;
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  loadAll(force?: boolean): Promise<void>;
}

export const useStorageStore = create<StorageStoreState>()((set, get) => ({
  stats: null,
  sessions: [],
  loading: false,
  error: null,

  async loadAll(force = false) {
    if (get().loading) {
      if (force) refreshAfterCurrentLoad = true;
      return;
    }
    if (!force && get().stats !== null) return;
    set({ loading: true, error: null });
    try {
      const [stats, summaries] = await Promise.all([
        systemApi.getStats(),
        systemApi.getSessionSummaries(),
      ]);
      set({ stats, sessions: summaries.sessions, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '存储统计读取失败', loading: false });
    } finally {
      if (refreshAfterCurrentLoad) {
        refreshAfterCurrentLoad = false;
        void get().loadAll(true);
      }
    }
  },
}));

let refreshAfterCurrentLoad = false;

// 存储域状态(单库化):库统计 + Session 摘要列表 + 加载态。
// 数据目录只有一个；进入页面及跨窗口持久数据变化后重新查询。
import { create } from 'zustand';
import { systemApi, type DataDirStats, type SessionSummary } from '../api/system.js';

interface StorageStoreState {
  stats: DataDirStats | null;
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
}

let refreshPromise: Promise<void> | null = null;
let refreshAgain = false;

export const useStorageStore = create<StorageStoreState>()(set => ({
  stats: null,
  sessions: [],
  loading: false,
  error: null,

  async refresh() {
    if (refreshPromise) {
      refreshAgain = true;
      return refreshPromise;
    }

    refreshPromise = (async () => {
      set({ loading: true, error: null });
      do {
        refreshAgain = false;
        try {
          const [stats, summaries] = await Promise.all([
            systemApi.getStats(),
            systemApi.getSessionSummaries(),
          ]);
          set({ stats, sessions: summaries.sessions, error: null });
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '存储统计读取失败' });
        }
      } while (refreshAgain);
      set({ loading: false });
    })();

    try {
      await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  },
}));

// 存储域状态(单库化):库统计 + Session 摘要列表 + 加载态。
// 无注册表/浏览缓存/库切换——数据目录只有一个,刷新触发点=本页进入与导入/删除会话后。
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
    if (get().loading) return;
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
    }
  },
}));

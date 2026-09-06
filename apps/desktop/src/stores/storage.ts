// 数据目录注册表与存储统计：目录切换/迁移归 workspaces 域，统计归 system 域。
import { create } from 'zustand';
import {
  dataDirsApi,
  type DataDirAddInput,
  type DataDirItem,
  type DataDirMigrateInput,
} from '../api/workspaces.js';
import { systemApi, type DataDirStats, type SessionStats } from '../api/system.js';

type DirSessionsResult = Awaited<ReturnType<typeof dataDirsApi.dirSessions>>;
export type DirSessionItem = DirSessionsResult['sessions'][number];
export type RemoveDirResult = Awaited<ReturnType<typeof dataDirsApi.removeDir>>;

// ── State shape ───────────────────────────────────────────────────────────────

interface StorageStoreState {
  dirs:         DataDirItem[];
  activeName:   string;
  dirsLoading:  boolean;
  dirsError:    string | null;

  stats:        DataDirStats | null;
  statsLoading: boolean;

  dashBySession: Map<string, SessionStats>;
  dashLoading:   Set<string>;
  dashErrors:    Map<string, string>;

  /** L1/L2 共用的按库统计与 session 列表(只读浏览, 任意已注册库)。 */
  statsByDir:    Map<string, DataDirStats>;
  sessionsByDir: Map<string, DirSessionItem[]>;
  dirBrowseLoading: Set<string>;

  loadDirs(): Promise<void>;
  addDir(input: DataDirAddInput): Promise<void>;
  removeDir(name: string, wipe?: boolean): Promise<RemoveDirResult>;
  activateDir(name: string): Promise<boolean>;
  migrate(input: DataDirMigrateInput): Promise<boolean>;
  loadDirStats(name: string, force?: boolean): Promise<void>;
  loadDirSessions(name: string, force?: boolean): Promise<void>;

  loadStats(): Promise<void>;

  loadDashboard(sid: string): Promise<void>;
  clearDashboard(sid: string): void;
  isDashLoading(sid: string): boolean;
  getDashError(sid: string): string | null;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useStorageStore = create<StorageStoreState>((set, get) => ({
  dirs:         [],
  activeName:   '',
  dirsLoading:  false,
  dirsError:    null,

  stats:        null,
  statsLoading: false,

  dashBySession: new Map(),
  dashLoading:   new Set(),
  dashErrors:    new Map(),

  statsByDir:    new Map(),
  sessionsByDir: new Map(),
  dirBrowseLoading: new Set(),

  // ── DataDir management ───────────────────────────────────────────────────

  async loadDirs() {
    set({ dirsLoading: true, dirsError: null });
    try {
      const res = await dataDirsApi.listDirs();
      set({ dirs: [...res.dirs], activeName: res.active, dirsLoading: false });
    } catch (err) {
      set({ dirsLoading: false, dirsError: err instanceof Error ? err.message : '加载失败' });
    }
  },

  async addDir(input) {
    await dataDirsApi.addDir(input);
    await get().loadDirs();
  },

  async removeDir(name, wipe = false) {
    const result = await dataDirsApi.removeDir(name, wipe);
    set((s) => {
      const st = new Map(s.statsByDir);    st.delete(name);
      const se = new Map(s.sessionsByDir); se.delete(name);
      return { statsByDir: st, sessionsByDir: se };
    });
    await get().loadDirs();
    return result;
  },

  async loadDirStats(name, force = false) {
    if (!force && get().statsByDir.has(name)) return;
    try {
      const stats = await dataDirsApi.dirStats(name);
      set((s) => {
        const m = new Map(s.statsByDir); m.set(name, stats as DataDirStats);
        return { statsByDir: m };
      });
    } catch { /* 单库统计失败不阻断其他卡片 */ }
  },

  async loadDirSessions(name, force = false) {
    if (!force && get().sessionsByDir.has(name)) return;
    set((s) => ({ dirBrowseLoading: new Set([...s.dirBrowseLoading, name]) }));
    try {
      const res = await dataDirsApi.dirSessions(name);
      set((s) => {
        const m = new Map(s.sessionsByDir); m.set(name, [...res.sessions]);
        const l = new Set(s.dirBrowseLoading); l.delete(name);
        return { sessionsByDir: m, dirBrowseLoading: l };
      });
    } catch {
      set((s) => {
        const l = new Set(s.dirBrowseLoading); l.delete(name);
        return { dirBrowseLoading: l };
      });
    }
  },

  async activateDir(name) {
    const res = await dataDirsApi.activateDir(name);
    await get().loadDirs();
    return res.restartRequired;
  },

  async migrate(input) {
    const res = await dataDirsApi.migrate(input);
    await get().loadDirs();
    return res.restartRequired;
  },

  // ── Aggregate stats ───────────────────────────────────────────────────────

  async loadStats() {
    set({ statsLoading: true });
    try {
      const s = await systemApi.getStats();
      set({ stats: s, statsLoading: false });
    } catch {
      set({ statsLoading: false });
    }
  },

  // ── Session dashboard cache ───────────────────────────────────────────────

  isDashLoading: (sid) => get().dashLoading.has(sid),
  getDashError:  (sid) => get().dashErrors.get(sid) ?? null,

  async loadDashboard(sid) {
    if (get().dashLoading.has(sid)) return;
    set((s) => ({
      dashLoading: new Set([...s.dashLoading, sid]),
      dashErrors:  (() => { const m = new Map(s.dashErrors); m.delete(sid); return m; })(),
    }));
    try {
      const dash = await systemApi.getSessionStats(sid);
      set((s) => {
        const m = new Map(s.dashBySession); m.set(sid, dash);
        const l = new Set(s.dashLoading);   l.delete(sid);
        return { dashBySession: m, dashLoading: l };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败';
      set((s) => {
        const e = new Map(s.dashErrors);  e.set(sid, msg);
        const l = new Set(s.dashLoading); l.delete(sid);
        return { dashErrors: e, dashLoading: l };
      });
    }
  },

  clearDashboard(sid) {
    set((s) => {
      const d = new Map(s.dashBySession); d.delete(sid);
      const e = new Map(s.dashErrors);    e.delete(sid);
      const l = new Set(s.dashLoading);   l.delete(sid);
      return { dashBySession: d, dashErrors: e, dashLoading: l };
    });
  },
}));

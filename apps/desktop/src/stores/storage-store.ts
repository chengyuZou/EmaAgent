import { create } from 'zustand';
import { storageApi } from '../api/storage.js';
import type { DataDirItem, StorageStatsWire, SessionDashboardWire } from '../api/storage.js';

// ── State shape ───────────────────────────────────────────────────────────────

interface StorageStoreState {
  dirs:         DataDirItem[];
  activeName:   string;
  dirsLoading:  boolean;
  dirsError:    string | null;

  stats:        StorageStatsWire | null;
  statsLoading: boolean;

  dashBySession: Map<string, SessionDashboardWire>;
  dashLoading:   Set<string>;
  dashErrors:    Map<string, string>;

  loadDirs(): Promise<void>;
  addDir(opts: { name: string; path: string }): Promise<void>;
  removeDir(name: string): Promise<void>;
  activateDir(name: string): Promise<boolean>;
  migrate(opts: { name: string; targetPath: string }): Promise<boolean>;

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

  // ── DataDir management ───────────────────────────────────────────────────

  async loadDirs() {
    set({ dirsLoading: true, dirsError: null });
    try {
      const res = await storageApi.listDirs();
      set({ dirs: res.dirs, activeName: res.active, dirsLoading: false });
    } catch (err) {
      set({ dirsLoading: false, dirsError: err instanceof Error ? err.message : '加载失败' });
    }
  },

  async addDir(opts) {
    await storageApi.addDir(opts);
    await get().loadDirs();
  },

  async removeDir(name) {
    await storageApi.removeDir(name);
    await get().loadDirs();
  },

  async activateDir(name) {
    const res = await storageApi.activateDir(name);
    await get().loadDirs();
    return res.restartRequired;
  },

  async migrate(opts) {
    const res = await storageApi.migrate(opts);
    await get().loadDirs();
    return res.restartRequired;
  },

  // ── Aggregate stats ───────────────────────────────────────────────────────

  async loadStats() {
    set({ statsLoading: true });
    try {
      const s = await storageApi.getStats();
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
      const dash = await storageApi.getDashboard(sid);
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

export type { DataDirItem, StorageStatsWire, SessionDashboardWire };

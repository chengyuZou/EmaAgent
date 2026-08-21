// 管理通用记忆统计、后台任务结果、维护操作与 Session 级开关。
import { create } from 'zustand';
import { memoryApi, type MemoryStats, type MaintenanceReport, type MemoryMaintenanceInput, type MemorySessionOverrides, type MemoryBackgroundHealth } from '../api/memory.js';
import type { MemoryTaskKind } from '@ema-agent/storage';

export type { MemorySessionOverrides };

// ── Sub-types ─────────────────────────────────────────────────────────────────

export interface ActiveMemoryTask {
  taskId:     string;
  kind:       MemoryTaskKind;
  sessionId?: string;
  startedAt:  number;
}

export interface ExtractionResult {
  nodes:      number;
  edges:      number;
  items:      number;
  lazyQueued: number;
  durationMs: number;
  completedAt: number;
}

export interface MemoryTaskFailure {
  taskId: string;
  error: string;
  failedAt: number;
  task?: ActiveMemoryTask;
}

// ── Store interface ───────────────────────────────────────────────────────────

export interface MemoryStoreState {
  /** Latest stats snapshot from the sidecar. Null until first fetch. */
  stats:        MemoryStats | null;
  statsLoading: boolean;
  statsError:   string | null;

  /**
   * Currently-running background tasks (taskId → task info).
   * Used to show a "memory: extracting…" indicator in the UI.
   */
  activeTasks: Map<string, ActiveMemoryTask>;
  failedTasks: Map<string, MemoryTaskFailure>;

  /**
   * Last successful extraction result per session.
   * Cleared when the session is evicted.
   */
  lastExtractionMap: Map<string, ExtractionResult>;

  /**
   * Last extraction error per session.
   */
  extractionErrorMap: Map<string, string>;

  /**
   * Result of the last maintenance run (either from HTTP response or SSE).
   * Null until maintenance is run at least once.
   */
  maintenanceReport: MaintenanceReport | null;
  maintenanceRunning: boolean;
  maintenanceError: string | null;

  /** 后台维护健康投影(M5);null 表示尚未拉取。 */
  health: MemoryBackgroundHealth | null;

  // ── Actions ─────────────────────────────────────────────────────────────

  /** Fetch latest stats from the sidecar. No-op if already loading. */
  refreshStats(): Promise<void>;

  /** 拉取后台维护健康投影。 */
  refreshHealth(): Promise<void>;
  /** SSE 健康事件到达时原位替换。 */
  onHealthChanged(health: MemoryBackgroundHealth): void;

  onTaskStarted(taskId: string, kind: MemoryTaskKind, sessionId?: string): void;
  onTaskCompleted(taskId: string):                                     void;
  onTaskFailed(taskId: string, error: string):                         void;
  clearTaskFailure(taskId: string):                                    void;

  onExtractionStarted(sessionId: string):                              void;
  onExtractionCompleted(sessionId: string, result: Omit<ExtractionResult, 'completedAt'>): void;
  onExtractionFailed(sessionId: string, error: string):                void;

  /** Called when the vector index was rebuilt — stats are stale, refresh them. */
  onIndexRebuilt(): void;

  /**
   * Run a maintenance pass via POST /api/memory/maintenance.
   * Returns the full MaintenanceReport (including preview rows).
   * If dryRun=false, also refreshes stats after completion.
   */
  runMaintenance(input?: MemoryMaintenanceInput): Promise<MaintenanceReport>;

  /** Called when maintenance_completed arrives on the system bus (dryRun=false → refresh stats). */
  onMaintenanceCompleted(decayedNodes: number, decayedItems: number, dryRun: boolean): void;
  /** Called when maintenance_failed arrives on the system bus. */
  onMaintenanceFailed(error: string): void;

  /**
   * Hard-delete a memory node. Refreshes stats on success.
   * Also used by the memory panel's node browser.
   */
  deleteNode(id: string): Promise<void>;
  /** Hard-delete a memory item. Refreshes stats on success. */
  deleteItem(id: string): Promise<void>;

  /**
   * Per-session memory overrides cache (keyed by sessionId).
   * Populated on demand; cleared when a session is evicted.
   */
  sessionOverrides: Map<string, MemorySessionOverrides>;
  /** Fetch and cache overrides for a session. Returns cached value if present. */
  getSessionOverrides(sessionId: string): Promise<MemorySessionOverrides>;
  /** Persist overrides for a session (partial — only provided keys are changed). */
  setSessionOverrides(sessionId: string, overrides: MemorySessionOverrides): Promise<void>;
  /** Remove a session's overrides from the cache (call when evicting the session). */
  evictSessionOverrides(sessionId: string): void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useMemoryStore = create<MemoryStoreState>((set, get) => ({
  stats:              null,
  statsLoading:       false,
  statsError:         null,
  activeTasks:        new Map(),
  failedTasks:        new Map(),
  lastExtractionMap:  new Map(),
  extractionErrorMap: new Map(),
  maintenanceReport:  null,
  maintenanceRunning: false,
  maintenanceError:   null,
  health:             null,
  sessionOverrides:   new Map(),

  // ── Stats ──────────────────────────────────────────────────────────────────

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

  async refreshHealth() {
    try {
      const health = await memoryApi.health();
      set({ health });
    } catch {
      // 健康投影拉取失败不打扰:保持旧值,下事件或下次打开再试。
    }
  },

  onHealthChanged(health) {
    set({ health });
  },

  // ── Background task tracking ───────────────────────────────────────────────

  onTaskStarted(taskId, kind, sessionId) {
    set((s) => {
      const tasks = new Map(s.activeTasks);
      tasks.set(taskId, { taskId, kind, sessionId, startedAt: Date.now() });
      const failures = new Map(s.failedTasks);
      failures.delete(taskId);
      return { activeTasks: tasks, failedTasks: failures };
    });
  },

  onTaskCompleted(taskId) {
    set((s) => {
      const tasks = new Map(s.activeTasks);
      tasks.delete(taskId);
      return { activeTasks: tasks };
    });
  },

  onTaskFailed(taskId, error) {
    set((s) => {
      const tasks = new Map(s.activeTasks);
      const task = tasks.get(taskId);
      tasks.delete(taskId);
      const failures = new Map(s.failedTasks);
      failures.set(taskId, { taskId, error, failedAt: Date.now(), task });
      return { activeTasks: tasks, failedTasks: failures };
    });
  },

  clearTaskFailure(taskId) {
    set((state) => {
      const failures = new Map(state.failedTasks);
      failures.delete(taskId);
      return { failedTasks: failures };
    });
  },

  // ── Extraction results ─────────────────────────────────────────────────────

  onExtractionStarted(_sessionId) {
    // No-op for now — active tasks are already tracked via onTaskStarted.
    // Reserved for per-session "extracting" badge if needed later.
  },

  onExtractionCompleted(sessionId, result) {
    set((s) => {
      const m = new Map(s.lastExtractionMap);
      m.set(sessionId, { ...result, completedAt: Date.now() });
      const errs = new Map(s.extractionErrorMap);
      errs.delete(sessionId);
      return { lastExtractionMap: m, extractionErrorMap: errs };
    });
    // Stats changed: new nodes/items/edges were written to DB.
    void get().refreshStats();
  },

  onExtractionFailed(sessionId, error) {
    set((s) => {
      const errs = new Map(s.extractionErrorMap);
      errs.set(sessionId, error);
      return { extractionErrorMap: errs };
    });
  },

  // ── Index ──────────────────────────────────────────────────────────────────

  onIndexRebuilt() {
    // Index was rebuilt — stats.index is stale.
    void get().refreshStats();
  },

  // ── Maintenance ────────────────────────────────────────────────────────────

  async runMaintenance(input) {
    set({ maintenanceRunning: true, maintenanceError: null });
    try {
      const report = await memoryApi.runMaintenance(input ?? {});
      set({ maintenanceReport: report, maintenanceRunning: false });
      // Real run mutated DB — stats (decayedNodes counts) are now stale.
      if (!report.dryRun) void get().refreshStats();
      return report;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ maintenanceRunning: false, maintenanceError: msg });
      throw err;
    }
  },

  onMaintenanceCompleted(decayedNodes, decayedItems, dryRun) {
    // SSE variant: no preview rows, but we know the outcome.
    set((s) => ({
      maintenanceReport: s.maintenanceReport
        ? { ...s.maintenanceReport, decayedNodes, decayedItems, dryRun }
        : { dryRun, decayedNodes, decayedItems, preview: { nodes: [], items: [], decayedAt: Date.now() } },
      maintenanceError: null,
    }));
    if (!dryRun) void get().refreshStats();
  },

  onMaintenanceFailed(error) {
    set({ maintenanceError: error });
  },

  // ── Node / Item delete ─────────────────────────────────────────────────────

  async deleteNode(id) {
    await memoryApi.deleteNode(id);
    void get().refreshStats();
  },

  async deleteItem(id) {
    await memoryApi.deleteItem(id);
    void get().refreshStats();
  },

  // ── Per-session overrides ──────────────────────────────────────────────────

  async getSessionOverrides(sessionId) {
    const cached = get().sessionOverrides.get(sessionId as string);
    if (cached) return cached;
    const overrides = await memoryApi.getSessionOverrides(sessionId);
    set((s) => {
      const m = new Map(s.sessionOverrides);
      m.set(sessionId as string, overrides);
      return { sessionOverrides: m };
    });
    return overrides;
  },

  async setSessionOverrides(sessionId, overrides) {
    const updated = await memoryApi.setSessionOverrides(sessionId, overrides);
    set((s) => {
      const m = new Map(s.sessionOverrides);
      m.set(sessionId as string, updated);
      return { sessionOverrides: m };
    });
  },

  evictSessionOverrides(sessionId) {
    set((s) => {
      const m = new Map(s.sessionOverrides);
      m.delete(sessionId as string);
      return { sessionOverrides: m };
    });
  },
}));

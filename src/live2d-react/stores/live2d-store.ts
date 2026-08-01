// 保存单个 Live2D 舞台的动作、表情意图与运行开关。
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { NEUTRAL_POSE, type Live2DPoseSnapshot } from '../composables/head-pose.js';

// ── Live2D runtime store ────────────────────────────────────────────────────
//
// Intent layer for the Live2D stage. Real Cubism parameters live inside
// coreModel; this store keeps "what the app wants the model to do".
//
// Write path:  callers → useLive2DStore (intent)
//              → Live2DStage subscription → useExpressionStore (runtime params)
//              → expressionController.applyExpressions (per-frame)
//
// Read path:   tools/UI read intent truth from useLive2DStore.activeExpressions
//              tools/UI read runtime param values from useExpressionStore.get()
//
// Duration ownership: live2dStore manages expression timers exclusively.
// expressionStore is a pure runtime param store — it does not run timers.
// When a timer fires here, removeExpression() is called, which triggers the
// Stage subscription, which calls expressionStore.deactivate().

// ── Types ───────────────────────────────────────────────────────────────────

/** Per-frame parameter override snapshot read by plugins. */
export interface ModelParameters {
  leftEyeOpen:  number;
  rightEyeOpen: number;
}

export const DEFAULT_MODEL_PARAMETERS: ModelParameters = {
  leftEyeOpen:  1,
  rightEyeOpen: 1,
};

export type ExpressionIntentSource = 'emotion' | 'ui' | 'agent' | 'system';

export interface ExpressionIntentOptions {
  value?:       boolean | number;
  durationSec?: number;
  source?:      ExpressionIntentSource;
}

export interface ActiveExpressionIntent {
  name:        string;
  value:       boolean | number;
  source:      ExpressionIntentSource;
  requestId:   string;
  createdAt:   number;
  durationSec?: number;
}

export interface MotionIntent {
  group:     string;
  requestId: string;
  createdAt: number;
  index?:    number;
}

// ── State (data only — no action methods) ───────────────────────────────────
//
// Keeping state and actions separate means initialState never contains method
// stubs, so reset() can safely spread only data fields without overwriting
// the real action implementations that live in the Zustand create callback.

export interface Live2DStoreState {
  activeExpressions:     ActiveExpressionIntent[];
  currentMotion:         MotionIntent | null;
  modelParameters:       ModelParameters;
  idleAnimationEnabled:  boolean;
  idleBeatEnabled:       boolean;
  autoBlinkEnabled:      boolean;
  forceAutoBlinkEnabled: boolean;
  expressionEnabled:     boolean;
  /** 鼠标视线追踪开关;关闭时眼珠回中(或由 saccade 接管)。 */
  mouseTrackEnabled:     boolean;
  /** 唇同步开关;关闭时口型释放到 0 并撤回 speechNod 贡献。 */
  lipSyncEnabled:        boolean;
  /** 设置页姿态滑块基准;由 head-pose 插件逐帧与 idle 摇摆、speechNod 合成后写入。 */
  pose:                  Live2DPoseSnapshot;
  availableExpressions:  string[];
  availableMotions:      Record<string, number>;
  ready:                 boolean;
}

// ── Actions ─────────────────────────────────────────────────────────────────

export interface Live2DStoreActions {
  /** Replace all active expressions with one, or clear all (name = null). */
  setExpression(name: string | null, options?: ExpressionIntentOptions): void;
  /** Activate or refresh one expression intent. */
  addExpression(name: string, options?: ExpressionIntentOptions): void;
  /** Deactivate an expression intent by name. */
  removeExpression(name: string): void;
  /** Toggle an expression. Returns true when now active. */
  toggleExpression(name: string, options?: ExpressionIntentOptions): boolean;
  /** Deactivate all expression intents. */
  clearExpressions(): void;
  /**
   * 轮换到下一个表情: 当前表情在候选列表中 → 下一项(末尾回首项);
   * 不在列表或没有激活表情 → 第一项; 空候选列表无操作。
   * 原子读取当前状态并返回新激活的表情名，没有候选时返回 null。
   */
  cycleExpression(): string | null;

  playMotion(group: string, index?: number): void;
  setModelParameters(patch: Partial<ModelParameters>): void;
  setIdleAnimationEnabled(value: boolean): void;
  setIdleBeatEnabled(value: boolean): void;
  setAutoBlinkEnabled(value: boolean): void;
  setForceAutoBlinkEnabled(value: boolean): void;
  setExpressionEnabled(value: boolean): void;
  setMouseTrackEnabled(value: boolean): void;
  setLipSyncEnabled(value: boolean): void;
  setPose(patch: Partial<Live2DPoseSnapshot>): void;

  /** Internal — written by Live2DStage after model load. */
  _setReady(ready: boolean): void;
  _setExpressionsAvailable(names: string[]): void;
  _setMotionsAvailable(groups: Record<string, number>): void;
  /** Reset all data to initial values. Does not touch action implementations. */
  reset(): void;
}

export type Live2DStore = Live2DStoreState & Live2DStoreActions;
export type Live2DStoreApi = UseBoundStore<StoreApi<Live2DStore>>;

// ── Initial state (data only — no method stubs) ──────────────────────────────

const initialState: Live2DStoreState = {
  activeExpressions:     [],
  currentMotion:         null,
  modelParameters:       { ...DEFAULT_MODEL_PARAMETERS },
  idleAnimationEnabled:  true,
  idleBeatEnabled:       true,
  autoBlinkEnabled:      true,
  forceAutoBlinkEnabled: false,
  expressionEnabled:     true,
  mouseTrackEnabled:     true,
  lipSyncEnabled:        true,
  pose:                  { ...NEUTRAL_POSE },
  availableExpressions:  [],
  availableMotions:      {},
  ready:                 false,
};

// ── Module-level counters + duration timer map ───────────────────────────────
//
// Not part of Zustand state — mutations are synchronous side effects that
// don't need subscriber notification on their own.

interface Live2DStoreResources {
  expressionSeq: number;
  motionSeq: number;
  expressionTimers: Map<string, ReturnType<typeof setTimeout>>;
}

function clearExpressionTimer(resources: Live2DStoreResources, name: string): void {
  const t = resources.expressionTimers.get(name);
  if (t !== undefined) clearTimeout(t);
  resources.expressionTimers.delete(name);
}

function clearAllExpressionTimers(resources: Live2DStoreResources): void {
  for (const t of resources.expressionTimers.values()) clearTimeout(t);
  resources.expressionTimers.clear();
}

// ── Intent factories ─────────────────────────────────────────────────────────

function createExpressionIntent(
  resources: Live2DStoreResources,
  name:    string,
  options: ExpressionIntentOptions = {},
): ActiveExpressionIntent {
  resources.expressionSeq += 1;
  const source    = options.source ?? 'system';
  const createdAt = Date.now();
  const intent: ActiveExpressionIntent = {
    name,
    value:     options.value ?? true,
    source,
    requestId: `${source}:expr:${name}:${createdAt}:${resources.expressionSeq}`,
    createdAt,
  };
  if (options.durationSec !== undefined) intent.durationSec = options.durationSec;
  return intent;
}

function createMotionIntent(
  resources: Live2DStoreResources,
  group: string,
  index?: number,
): MotionIntent {
  resources.motionSeq += 1;
  const createdAt = Date.now();
  const intent: MotionIntent = {
    group,
    requestId: `motion:${group}:${createdAt}:${resources.motionSeq}`,
    createdAt,
  };
  if (index !== undefined) intent.index = index;
  return intent;
}

// ── Store ────────────────────────────────────────────────────────────────────

export function createLive2DStore(): Live2DStoreApi {
  const resources: Live2DStoreResources = {
    expressionSeq: 0,
    motionSeq: 0,
    expressionTimers: new Map(),
  };

  return create<Live2DStore>((set, get) => {
  // ── Duration expiry (scoped to create to access set/get) ─────────────────
  //
  // When the timer fires, removeExpression() updates activeExpressions.
  // Live2DStage's subscription detects the removal and calls
  // expressionStore.deactivate(name), keeping both stores in sync.
  //
  // requestId guard: prevents a stale timer from deleting a newer intent
  // that replaced the timed-out one (e.g. addExpression called again before
  // the previous durationSec elapsed).
  function scheduleExpiry(intent: ActiveExpressionIntent): void {
    const { name, requestId, durationSec } = intent;
    if (!durationSec || durationSec <= 0) return;

    resources.expressionTimers.set(name, setTimeout(() => {
      resources.expressionTimers.delete(name);
      const current = get().activeExpressions;
      if (current.some((i) => i.name === name && i.requestId === requestId)) {
        set({ activeExpressions: current.filter((i) => i.name !== name) });
      }
    }, durationSec * 1000));
  }

  return {
    ...initialState,

    // ── Expression management ────────────────────────────────────────────

    setExpression(name, options) {
      clearAllExpressionTimers(resources);
      if (name === null) {
        set({ activeExpressions: [] });
        return;
      }
      const intent = createExpressionIntent(resources, name, options);
      set({ activeExpressions: [intent] });
      scheduleExpiry(intent);
    },

    addExpression(name, options) {
      clearExpressionTimer(resources, name);
      const intent  = createExpressionIntent(resources, name, options);
      const current = get().activeExpressions;
      const idx     = current.findIndex((i) => i.name === name);
      if (idx >= 0) {
        const next = [...current];
        next[idx]  = intent;
        set({ activeExpressions: next });
      } else {
        set({ activeExpressions: [...current, intent] });
      }
      scheduleExpiry(intent);
    },

    removeExpression(name) {
      clearExpressionTimer(resources, name);
      set((s) => ({
        activeExpressions: s.activeExpressions.filter((i) => i.name !== name),
      }));
    },

    toggleExpression(name, options): boolean {
      const current = get().activeExpressions;
      const idx     = current.findIndex((i) => i.name === name);
      if (idx >= 0) {
        clearExpressionTimer(resources, name);
        set({ activeExpressions: current.filter((i) => i.name !== name) });
        return false;
      }
      clearExpressionTimer(resources, name); // safety clear
      const intent = createExpressionIntent(resources, name, options);
      set({ activeExpressions: [...current, intent] });
      scheduleExpiry(intent);
      return true;
    },

    clearExpressions() {
      clearAllExpressionTimers(resources);
      set({ activeExpressions: [] });
    },

    cycleExpression() {
      const { availableExpressions, activeExpressions } = get();
      if (availableExpressions.length === 0) return null;
      const current = activeExpressions[0]?.name;
      const idx = current ? availableExpressions.indexOf(current) : -1;
      const next = availableExpressions[(idx + 1) % availableExpressions.length]!;
      // 复用 setExpression: 原子替换为单一表情, 并清掉旧表情的 duration timer。
      get().setExpression(next, { source: 'ui' });
      return next;
    },

    // ── Motion / parameters / flags ──────────────────────────────────────

    playMotion(group, index) {
      set({ currentMotion: createMotionIntent(resources, group, index) });
    },

    setModelParameters(patch) {
      set((s) => ({ modelParameters: { ...s.modelParameters, ...patch } }));
    },

    setIdleAnimationEnabled(value)  { set({ idleAnimationEnabled:  value }); },
    setIdleBeatEnabled(value)       { set({ idleBeatEnabled:       value }); },
    setAutoBlinkEnabled(value)      { set({ autoBlinkEnabled:      value }); },
    setForceAutoBlinkEnabled(value) { set({ forceAutoBlinkEnabled: value }); },
    setExpressionEnabled(value)     { set({ expressionEnabled:     value }); },
    setMouseTrackEnabled(value)     { set({ mouseTrackEnabled:     value }); },
    setLipSyncEnabled(value)        { set({ lipSyncEnabled:        value }); },
    setPose(patch) {
      set((s) => ({ pose: { ...s.pose, ...patch } }));
    },

    _setReady(ready)                { set({ ready }); },
    _setExpressionsAvailable(names) { set({ availableExpressions: names }); },
    _setMotionsAvailable(groups)    { set({ availableMotions: groups }); },

    reset() {
      // Only spread data fields — action implementations are not in initialState
      // so Zustand's shallow merge leaves them intact.
      clearAllExpressionTimers(resources);
      set(initialState);
    },
    };
  });
}

export const useLive2DStore = createLive2DStore();

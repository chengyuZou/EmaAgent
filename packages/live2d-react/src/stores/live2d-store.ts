import { create } from 'zustand';

// ── Live2D runtime store ────────────────────────────────────────────────────
//
// This store is an intent layer, not the Cubism parameter store. Real Live2D
// parameters live inside the Cubism coreModel and are written during the
// per-frame pipeline. The store keeps "what the app wants the model to do".

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
  value?: boolean | number;
  durationSec?: number;
  source?: ExpressionIntentSource;
}

export interface ActiveExpressionIntent {
  name: string;
  value: boolean | number;
  source: ExpressionIntentSource;
  requestId: string;
  createdAt: number;
  durationSec?: number;
}

export interface MotionIntent {
  group: string;
  requestId: string;
  createdAt: number;
  index?: number;
}

export interface Live2DStoreState {
  // ── Desired state ──────────────────────────────────────────────────────
  /**
   * High-level expression intents. Multiple expressions may be active at once.
   * The stage reconciles these intents into ExpressionStore values.
   */
  activeExpressions: ActiveExpressionIntent[];
  /** Replace all active expressions with a single expression, or clear all. */
  setExpression(name: string | null, options?: ExpressionIntentOptions): void;
  /** Activate or refresh one expression intent. */
  addExpression(name: string, options?: ExpressionIntentOptions): void;
  /** Deactivate an expression intent. */
  removeExpression(name: string): void;
  /** Toggle one expression intent. Returns true when now active. */
  toggleExpression(name: string, options?: ExpressionIntentOptions): boolean;
  /** Deactivate all expression intents. */
  clearExpressions(): void;

  currentMotion:    MotionIntent | null;
  modelParameters:  ModelParameters;
  /** User toggle: allow scheduled idle motions to play. */
  idleAnimationEnabled:  boolean;
  /** User toggle: autonomous gentle head sway. */
  idleBeatEnabled:       boolean;
  /** User toggle: auto-eye-blink globally on. */
  autoBlinkEnabled:      boolean;
  /** Force the state-machine blink even when the model has native blink. */
  forceAutoBlinkEnabled: boolean;
  /** Expression overlay active (gates auto-blink path selection). */
  expressionEnabled:     boolean;

  // ── Discovered state ───────────────────────────────────────────────────
  availableExpressions: string[];
  availableMotions:     Record<string, number>;
  ready: boolean;
}

export interface Live2DStoreActions {
  playMotion(group: string, index?: number): void;
  setModelParameters(patch: Partial<ModelParameters>): void;
  setIdleAnimationEnabled(value: boolean): void;
  setIdleBeatEnabled(value: boolean): void;
  setAutoBlinkEnabled(value: boolean): void;
  setForceAutoBlinkEnabled(value: boolean): void;
  setExpressionEnabled(value: boolean): void;

  // Internal — set by Live2DStage / model loader
  _setReady(ready: boolean): void;
  _setExpressionsAvailable(names: string[]): void;
  _setMotionsAvailable(groups: Record<string, number>): void;
  reset(): void;
}

export type Live2DStore = Live2DStoreState & Live2DStoreActions;

const initial: Live2DStoreState = {
  activeExpressions:    [],
  currentMotion:        null,
  modelParameters:      { ...DEFAULT_MODEL_PARAMETERS },
  idleAnimationEnabled:  true,
  idleBeatEnabled:       true,
  autoBlinkEnabled:      true,
  forceAutoBlinkEnabled: false,
  expressionEnabled:     true,

  availableExpressions: [],
  availableMotions:     {},
  ready: false,

  // Methods are assigned below.
  setExpression: () => { /* assigned */ },
  addExpression: () => { /* assigned */ },
  removeExpression: () => { /* assigned */ },
  toggleExpression: () => false,
  clearExpressions: () => { /* assigned */ },
};

let expressionSeq = 0;
let motionSeq = 0;

function createExpressionIntent(
  name: string,
  options: ExpressionIntentOptions = {},
): ActiveExpressionIntent {
  expressionSeq += 1;
  const source = options.source ?? 'system';
  const createdAt = Date.now();
  const intent: ActiveExpressionIntent = {
    name,
    value: options.value ?? true,
    source,
    requestId: `${source}:expr:${name}:${createdAt}:${expressionSeq}`,
    createdAt,
  };
  if (options.durationSec !== undefined) intent.durationSec = options.durationSec;
  return intent;
}

function createMotionIntent(group: string, index?: number): MotionIntent {
  motionSeq += 1;
  const createdAt = Date.now();
  const intent: MotionIntent = {
    group,
    requestId: `motion:${group}:${createdAt}:${motionSeq}`,
    createdAt,
  };
  if (index !== undefined) intent.index = index;
  return intent;
}

export const useLive2DStore = create<Live2DStore>((set, get) => ({
  ...initial,

  // ── Expression management ──────────────────────────────────────────────

  setExpression(name, options) {
    if (name === null) {
      set({ activeExpressions: [] });
      return;
    }
    set({ activeExpressions: [createExpressionIntent(name, options)] });
  },

  addExpression(name, options) {
    const current = get().activeExpressions;
    const nextIntent = createExpressionIntent(name, options);
    const idx = current.findIndex((intent) => intent.name === name);
    if (idx >= 0) {
      const next = [...current];
      next[idx] = nextIntent;
      set({ activeExpressions: next });
      return;
    }
    set({ activeExpressions: [...current, nextIntent] });
  },

  removeExpression(name) {
    set((s) => ({
      activeExpressions: s.activeExpressions.filter((intent) => intent.name !== name),
    }));
  },

  toggleExpression(name, options): boolean {
    const current = get().activeExpressions;
    const idx = current.findIndex((intent) => intent.name === name);
    if (idx >= 0) {
      set({ activeExpressions: current.filter((intent) => intent.name !== name) });
      return false;
    }
    set({ activeExpressions: [...current, createExpressionIntent(name, options)] });
    return true;
  },

  clearExpressions() {
    set({ activeExpressions: [] });
  },

  // ── Motion / parameters / flags ───────────────────────────────────────

  playMotion(group, index) {
    set({ currentMotion: createMotionIntent(group, index) });
  },

  setModelParameters(patch) {
    set((s) => ({ modelParameters: { ...s.modelParameters, ...patch } }));
  },

  setIdleAnimationEnabled(value)  { set({ idleAnimationEnabled:  value }); },
  setIdleBeatEnabled(value)       { set({ idleBeatEnabled:       value }); },
  setAutoBlinkEnabled(value)      { set({ autoBlinkEnabled:      value }); },
  setForceAutoBlinkEnabled(value) { set({ forceAutoBlinkEnabled: value }); },
  setExpressionEnabled(value)     { set({ expressionEnabled:     value }); },

  _setReady(ready)                { set({ ready }); },
  _setExpressionsAvailable(names) { set({ availableExpressions: names }); },
  _setMotionsAvailable(groups)    { set({ availableMotions: groups }); },
  reset()                         { set({ ...initial }); },
}));

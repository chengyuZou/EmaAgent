import { create } from 'zustand';

// ── Live2D runtime store ────────────────────────────────────────────────────
//
// External state for the currently-mounted Live2D model. Two roles:
//
//   1. **Desired state** — set by callers (SSE emotion_changed, UI buttons,
//      LLM tools):
//        activeExpressions[], currentMotion, idle/blink flags, modelParameters
//
//   2. **Discovered state** — populated by the model on load:
//        availableExpressions, availableMotions, ready
//
// Expression management follows AIRI's design: multiple expressions can be
// active simultaneously (e.g. Smile + Blush at the same time). Each expression
// writes to different Live2D parameters; the expression-store's Map
// deduplicates by parameterId. The activeExpressions[] array is the
// **high-level intent** — Live2DStage reconciles it against the
// expression-store every time it changes.
//
// modelParameters is intentionally a runtime override layer (eye open base,
// future: brows / mouth / cheek). Defaults to "neutral" — modify to "pose"
// the character without playing a motion.

// ── Types ───────────────────────────────────────────────────────────────────

/** Per-frame parameter override snapshot read by plugins. */
export interface ModelParameters {
  leftEyeOpen:  number;
  rightEyeOpen: number;
  // Reserved for future expansion (brows / cheek / mouth) — kept flat for
  // cheap reads inside the per-frame plugin loop.
}

export const DEFAULT_MODEL_PARAMETERS: ModelParameters = {
  leftEyeOpen:  1,
  rightEyeOpen: 1,
};

export interface Live2DStoreState {
  // ── Desired state ──────────────────────────────────────────────────────
  /**
   * Currently-active expression group names. Multiple expressions can be
   * active at once (e.g. ["Smile", "Blush"]). An empty array means all
   * expressions are at their default/modelDefault values.
   *
   * Order matters — later entries overlay on top of earlier ones if they
   * touch the same parameter.
   */
  activeExpressions: string[];
  /**
   * Convenience setter: replace all active expressions with a single name.
   * @deprecated Prefer addExpression/removeExpression/toggleExpression for
   * multi-expression control. This exists for Live2DStageHandle backward
   * compatibility and simple single-expression callers.
   */
  setExpression(name: string | null): void;
  /** Activate an expression. No-op if already active. */
  addExpression(name: string, durationSec?: number): void;
  /** Deactivate an expression (restore its parameters to default). No-op if not active. */
  removeExpression(name: string): void;
  /** Toggle an expression on/off. Returns the new state. */
  toggleExpression(name: string, durationSec?: number): boolean;
  /** Deactivate all expressions. */
  clearExpressions(): void;

  currentMotion:    { group: string; index?: number } | null;
  modelParameters:  ModelParameters;
  /** User toggle: allow idle motions to play. */
  idleAnimationEnabled:  boolean;
  /** User toggle: autonomous gentle head sway when no TTS/interaction. */
  idleBeatEnabled:       boolean;
  /** User toggle: auto-eye-blink globally on. */
  autoBlinkEnabled:      boolean;
  /**
   * Force the state-machine blink even when the model has its own idle blink
   * curves. Useful for testing or for models with broken curves. Default off.
   */
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

  // Methods are assigned below
  setExpression: () => { /* assigned */ },
  addExpression: () => { /* assigned */ },
  removeExpression: () => { /* assigned */ },
  toggleExpression: () => false,
  clearExpressions: () => { /* assigned */ },
};

export const useLive2DStore = create<Live2DStore>((set, get) => ({
  ...initial,

  // ── Expression management ──────────────────────────────────────────────

  /**
   * Replace all active expressions with a single name (or none).
   * This is both a state setter AND a method — callers write
   * `useLive2DStore.getState().setExpression("Smile")` to activate one,
   * or `setExpression(null)` to clear all.
   */
  setExpression(name) {
    if (name === null) {
      set({ activeExpressions: [] });
    } else {
      set({ activeExpressions: [name] });
    }
  },

  /** Activate an expression. Duplicate names are ignored. */
  addExpression(name, _durationSec) {
    const current = get().activeExpressions;
    if (current.includes(name)) return;
    set({ activeExpressions: [...current, name] });
  },

  /** Deactivate an expression. Missing names are silently ignored. */
  removeExpression(name) {
    set((s) => ({
      activeExpressions: s.activeExpressions.filter((e) => e !== name),
    }));
  },

  /** Toggle an expression. Returns true if it's now active. */
  toggleExpression(name, _durationSec): boolean {
    const current = get().activeExpressions;
    const idx = current.indexOf(name);
    if (idx >= 0) {
      set({ activeExpressions: current.filter((e) => e !== name) });
      return false;
    }
    set({ activeExpressions: [...current, name] });
    return true;
  },

  /** Deactivate all expressions. */
  clearExpressions() {
    set({ activeExpressions: [] });
  },

  // ── Motion / parameters / flags ───────────────────────────────────────

  playMotion(group, index)         { set({ currentMotion: { group, index } }); },
  setModelParameters(patch) {
    set((s) => ({ modelParameters: { ...s.modelParameters, ...patch } }));
  },
  setIdleAnimationEnabled(value)   { set({ idleAnimationEnabled:  value }); },
  setIdleBeatEnabled(value)        { set({ idleBeatEnabled:       value }); },
  setAutoBlinkEnabled(value)       { set({ autoBlinkEnabled:      value }); },
  setForceAutoBlinkEnabled(value)  { set({ forceAutoBlinkEnabled: value }); },
  setExpressionEnabled(value)      { set({ expressionEnabled:     value }); },

  _setReady(ready)                 { set({ ready }); },
  _setExpressionsAvailable(names)  { set({ availableExpressions: names }); },
  _setMotionsAvailable(groups)     { set({ availableMotions: groups }); },
  reset()                          { set({ ...initial }); },
}));

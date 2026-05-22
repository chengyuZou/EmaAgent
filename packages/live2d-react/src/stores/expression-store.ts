import { create } from 'zustand';

// ── Live2D expression store ─────────────────────────────────────────────────
//
// Tracks per-parameter expression overrides parsed from .exp3.json files.
// Two layers of indirection:
//   1. ExpressionGroupDefinition — one named expression ("Happy", "Sad")
//      contains a list of parameter overrides (which Live2D params, what blend
//      mode, what target value).
//   2. ExpressionEntry — one Live2D parameter (e.g. ParamMouthForm) and its
//      current runtime value. Multiple expression groups may write to the
//      same parameter; this Map merges by parameter ID.
//
// Ported from AIRI's stage-ui-live2d/stores/expression-store.ts. Pinia →
// Zustand. Vue Refs → plain state. localStorage persistence preserved
// because it's framework-agnostic.

// ── Types ───────────────────────────────────────────────────────────────────

export type ExpressionBlendMode = 'Add' | 'Multiply' | 'Overwrite';

/**
 * A single Live2D parameter tracked by the expression system. One per Live2D
 * parameter ID (not one per expression group — multiple groups may touch the
 * same param, the Map deduplicates).
 */
export interface ExpressionEntry {
  /** Human-readable name (typically same as parameterId in our use). */
  name:         string;
  /** Live2D parameter ID (e.g. "ParamMouthForm"). */
  parameterId:  string;
  /** Blend mode for this parameter. */
  blend:        ExpressionBlendMode;
  /** Runtime value applied every frame. */
  currentValue: number;
  /** Application-level default (may be user-overridden via saveDefaults). */
  defaultValue: number;
  /** Original default baked into the model (from coreModel default API). */
  modelDefault: number;
  /** exp3-specified activation value (the "on" state). */
  targetValue:  number;
  /** Active auto-reset timer handle, if any. */
  resetTimer?:  ReturnType<typeof setTimeout>;
}

export interface ExpressionGroupParam {
  parameterId: string;
  blend:       ExpressionBlendMode;
  value:       number;
}

export interface ExpressionGroupDefinition {
  /** Name as declared in model3.json (e.g. "Happy"). */
  name:       string;
  parameters: ExpressionGroupParam[];
}

export interface ExpressionState {
  name:        string;
  value:       number;
  default:     number;
  active:      boolean;
  autoResetAt?: number;
}

export interface ExpressionToolResult {
  success:    boolean;
  error?:     string;
  state?:     ExpressionState | ExpressionState[];
  available?: string[];
}

// ── Persistence helpers (localStorage) ──────────────────────────────────────

function persistenceKey(modelId: string): string {
  return `ema-expression-defaults:${modelId}`;
}

function loadPersistedDefaults(modelId: string): Record<string, number> | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(persistenceKey(modelId));
    return raw ? JSON.parse(raw) as Record<string, number> : null;
  } catch {
    return null;
  }
}

function savePersistedDefaults(modelId: string, defaults: Record<string, number>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(persistenceKey(modelId), JSON.stringify(defaults));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[expression-store] failed to persist defaults', err);
  }
}

// ── Store ───────────────────────────────────────────────────────────────────

interface ExpressionStoreState {
  /** Map<parameterId | groupName, entry> — single source of truth for runtime values. */
  expressions:      Map<string, ExpressionEntry>;
  /** Map<groupName, groupDef> — exp3 group definitions parsed once at load. */
  expressionGroups: Map<string, ExpressionGroupDefinition>;
  modelId:          string;
}

interface ExpressionStoreActions {
  registerExpressions(
    modelId: string,
    groups:  ExpressionGroupDefinition[],
    entries: ExpressionEntry[],
  ): void;
  resolve(name: string):
    | { kind: 'group'; group: ExpressionGroupDefinition }
    | { kind: 'param'; entry: ExpressionEntry }
    | null;
  set(name: string, value: boolean | number, durationSec?: number): ExpressionToolResult;
  get(name?: string): ExpressionToolResult;
  toggle(name: string, durationSec?: number): ExpressionToolResult;
  saveDefaults(): ExpressionToolResult;
  resetAll(): ExpressionToolResult;
  dispose(): void;
}

export type ExpressionStore = ExpressionStoreState & ExpressionStoreActions;

const initial: ExpressionStoreState = {
  expressions:      new Map(),
  expressionGroups: new Map(),
  modelId:          '',
};

export const useExpressionStore = create<ExpressionStore>((set, get) => ({
  ...initial,

  // ── registerExpressions ──────────────────────────────────────────────────
  registerExpressions(modelId, groups, entries) {
    clearAllTimers(get().expressions);

    const expressionGroups = new Map<string, ExpressionGroupDefinition>();
    for (const g of groups) expressionGroups.set(g.name, g);

    const expressions = new Map<string, ExpressionEntry>();
    for (const e of entries) expressions.set(e.name, { ...e });

    // Restore persisted user defaults
    const persisted = loadPersistedDefaults(modelId);
    if (persisted) {
      for (const [name, val] of Object.entries(persisted)) {
        const entry = expressions.get(name);
        if (entry) {
          entry.defaultValue = val;
          entry.currentValue = val;
        }
      }
    }

    set({ expressions, expressionGroups, modelId });
  },

  // ── resolve ──────────────────────────────────────────────────────────────
  resolve(name) {
    const state = get();
    const group = state.expressionGroups.get(name);
    if (group) return { kind: 'group', group };
    const entry = state.expressions.get(name);
    if (entry) return { kind: 'param', entry };
    return null;
  },

  // ── set ──────────────────────────────────────────────────────────────────
  set(name, value, durationSec) {
    const resolved = get().resolve(name);
    if (!resolved) {
      return { success: false, error: `Expression "${name}" not found`, available: allNames(get().expressions) };
    }
    const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    if (resolved.kind === 'group') {
      const states: ExpressionState[] = [];
      for (const param of resolved.group.parameters) {
        const entry = get().expressions.get(param.parameterId);
        if (entry) {
          applyValue(entry, numeric, durationSec);
          states.push(toState(entry));
        }
      }
      // Trigger a Map identity bump so React subscribers re-render
      set((s) => ({ expressions: new Map(s.expressions) }));
      return { success: true, state: states };
    }
    applyValue(resolved.entry, numeric, durationSec);
    set((s) => ({ expressions: new Map(s.expressions) }));
    return { success: true, state: toState(resolved.entry) };
  },

  // ── get ──────────────────────────────────────────────────────────────────
  get(name) {
    const state = get();
    if (!name) {
      const states: ExpressionState[] = [];
      for (const entry of state.expressions.values()) states.push(toState(entry));
      return { success: true, state: states };
    }
    const resolved = state.resolve(name);
    if (!resolved) {
      return { success: false, error: `Expression "${name}" not found`, available: allNames(state.expressions) };
    }
    if (resolved.kind === 'group') {
      const states: ExpressionState[] = [];
      for (const param of resolved.group.parameters) {
        const entry = state.expressions.get(param.parameterId);
        if (entry) states.push(toState(entry));
      }
      return { success: true, state: states };
    }
    return { success: true, state: toState(resolved.entry) };
  },

  // ── toggle ───────────────────────────────────────────────────────────────
  toggle(name, durationSec) {
    const resolved = get().resolve(name);
    if (!resolved) {
      return { success: false, error: `Expression "${name}" not found`, available: allNames(get().expressions) };
    }
    if (resolved.kind === 'group') {
      // "Active" = at least one non-zero target param is currently at its target value
      const isActive = resolved.group.parameters.some((p) => {
        if (p.value === 0) return false;
        const entry = get().expressions.get(p.parameterId);
        return entry !== undefined && entry.currentValue === p.value;
      });
      const states: ExpressionState[] = [];
      for (const param of resolved.group.parameters) {
        const entry = get().expressions.get(param.parameterId);
        if (entry) {
          const next = isActive ? entry.modelDefault : param.value;
          applyValue(entry, next, durationSec);
          states.push(toState(entry));
        }
      }
      set((s) => ({ expressions: new Map(s.expressions) }));
      return { success: true, state: states };
    }
    const entry = resolved.entry;
    const next  = entry.currentValue !== entry.modelDefault ? entry.modelDefault : entry.targetValue;
    applyValue(entry, next, durationSec);
    set((s) => ({ expressions: new Map(s.expressions) }));
    return { success: true, state: toState(entry) };
  },

  // ── saveDefaults ─────────────────────────────────────────────────────────
  saveDefaults() {
    const state = get();
    if (!state.modelId) return { success: false, error: 'No model loaded' };
    const defaults: Record<string, number> = {};
    for (const [name, entry] of state.expressions) {
      entry.defaultValue = entry.currentValue;
      defaults[name] = entry.currentValue;
    }
    savePersistedDefaults(state.modelId, defaults);
    return { success: true };
  },

  // ── resetAll ─────────────────────────────────────────────────────────────
  resetAll() {
    const state = get();
    clearAllTimers(state.expressions);
    const states: ExpressionState[] = [];
    for (const entry of state.expressions.values()) {
      entry.currentValue = entry.modelDefault;
      states.push(toState(entry));
    }
    set((s) => ({ expressions: new Map(s.expressions) }));
    return { success: true, state: states };
  },

  // ── dispose ──────────────────────────────────────────────────────────────
  dispose() {
    clearAllTimers(get().expressions);
    set({ ...initial });
  },
}));

// ── Internal helpers ────────────────────────────────────────────────────────

function clearAllTimers(map: Map<string, ExpressionEntry>): void {
  for (const entry of map.values()) {
    if (entry.resetTimer !== undefined) {
      clearTimeout(entry.resetTimer);
      entry.resetTimer = undefined;
    }
  }
}

function allNames(map: Map<string, ExpressionEntry>): string[] {
  return Array.from(map.keys());
}

function toState(entry: ExpressionEntry): ExpressionState {
  return {
    name:        entry.name,
    value:       entry.currentValue,
    default:     entry.defaultValue,
    active:      entry.currentValue !== entry.defaultValue,
    autoResetAt: entry.resetTimer !== undefined ? Date.now() : undefined,
  };
}

function applyValue(entry: ExpressionEntry, value: number, durationSec?: number): void {
  if (entry.resetTimer !== undefined) {
    clearTimeout(entry.resetTimer);
    entry.resetTimer = undefined;
  }
  entry.currentValue = value;
  if (durationSec && durationSec > 0) {
    const resetTo = entry.defaultValue;
    entry.resetTimer = setTimeout(() => {
      entry.currentValue = resetTo;
      entry.resetTimer = undefined;
    }, durationSec * 1000);
  }
}

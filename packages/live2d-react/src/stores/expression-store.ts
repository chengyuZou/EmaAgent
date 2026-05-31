import { create } from 'zustand';

// ── Live2D expression store ─────────────────────────────────────────────────
//
// Stores expression data after .exp3.json has been parsed. It does not fetch
// model files and it does not render. Live2DStage owns parsing and the
// expression-controller applies these values to Cubism every frame.

// ── Types ───────────────────────────────────────────────────────────────────

export type ExpressionBlendMode = 'Add' | 'Multiply' | 'Overwrite';

export interface ExpressionEntry {
  /** Human-readable name. In current code this is the same as parameterId. */
  name: string;
  /** Live2D parameter ID, e.g. ParamMouthForm. */
  parameterId: string;
  /** Blend mode used when applying this parameter. */
  blend: ExpressionBlendMode;
  /** Runtime value applied by expression-controller every frame. */
  currentValue: number;
  /** Application-level default; may be persisted per model. */
  defaultValue: number;
  /** Model-baked default read from Cubism when possible. */
  modelDefault: number;
  /** Activation value from exp3. */
  targetValue: number;
  resetTimer?: ReturnType<typeof setTimeout>;
  resetAt?: number;
}

export interface ExpressionGroupParam {
  parameterId: string;
  blend: ExpressionBlendMode;
  value: number;
}

export interface ExpressionGroupDefinition {
  name: string;
  parameters: ExpressionGroupParam[];
}

export interface ExpressionState {
  name: string;
  value: number;
  default: number;
  active: boolean;
  autoResetAt?: number;
}

export interface ExpressionToolResult {
  success: boolean;
  error?: string;
  state?: ExpressionState | ExpressionState[];
  available?: string[];
}

interface ExpressionStoreState {
  /** Map<parameterId, entry>. */
  expressions: Map<string, ExpressionEntry>;
  /** Map<expressionName, groupDef>. */
  expressionGroups: Map<string, ExpressionGroupDefinition>;
  modelId: string;
}

interface ExpressionStoreActions {
  registerExpressions(
    modelId: string,
    groups: ExpressionGroupDefinition[],
    entries: ExpressionEntry[],
  ): void;
  resolve(name: string):
    | { kind: 'group'; group: ExpressionGroupDefinition }
    | { kind: 'param'; entry: ExpressionEntry }
    | null;
  set(name: string, value: boolean | number, durationSec?: number): ExpressionToolResult;
  activate(name: string, value?: boolean | number, durationSec?: number): ExpressionToolResult;
  deactivate(name: string): ExpressionToolResult;
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

// ── Persistence helpers ─────────────────────────────────────────────────────

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

export const useExpressionStore = create<ExpressionStore>((set, get) => {
  const bump = (): void => {
    set((s) => ({ expressions: new Map(s.expressions) }));
  };

  const applyEntryValue = (
    entry: ExpressionEntry,
    value: number,
    durationSec?: number,
  ): void => {
    clearTimer(entry);
    entry.currentValue = value;
    entry.resetAt = undefined;

    if (durationSec !== undefined && durationSec > 0) {
      const resetTo = entry.defaultValue;
      entry.resetAt = Date.now() + durationSec * 1000;
      entry.resetTimer = setTimeout(() => {
        entry.currentValue = resetTo;
        entry.resetTimer = undefined;
        entry.resetAt = undefined;
        bump();
      }, durationSec * 1000);
    }
  };

  const applyGroup = (
    group: ExpressionGroupDefinition,
    value: boolean | number,
    durationSec?: number,
  ): ExpressionState[] => {
    const states: ExpressionState[] = [];
    for (const param of group.parameters) {
      const entry = get().expressions.get(param.parameterId);
      if (!entry) continue;

      let nextValue: number;
      if (typeof value === 'boolean') {
        nextValue = value ? param.value : entry.defaultValue;
      } else {
        nextValue = param.value * value;
      }

      applyEntryValue(entry, nextValue, durationSec);
      states.push(toState(entry));
    }
    return states;
  };

  return {
    ...initial,

    registerExpressions(modelId, groups, entries) {
      clearAllTimers(get().expressions);

      const expressionGroups = new Map<string, ExpressionGroupDefinition>();
      for (const group of groups) expressionGroups.set(group.name, group);

      const expressions = new Map<string, ExpressionEntry>();
      for (const entry of entries) expressions.set(entry.parameterId, { ...entry });

      const persisted = loadPersistedDefaults(modelId);
      if (persisted) {
        for (const [name, value] of Object.entries(persisted)) {
          const entry = expressions.get(name);
          if (entry) {
            entry.defaultValue = value;
            entry.currentValue = value;
          }
        }
      }

      set({ expressions, expressionGroups, modelId });
    },

    resolve(name) {
      const state = get();
      const group = state.expressionGroups.get(name);
      if (group) return { kind: 'group', group };
      const entry = state.expressions.get(name);
      if (entry) return { kind: 'param', entry };
      return null;
    },

    set(name, value, durationSec) {
      const resolved = get().resolve(name);
      if (!resolved) return notFound(name, get());

      if (resolved.kind === 'group') {
        const states = applyGroup(resolved.group, value, durationSec);
        bump();
        return { success: true, state: states };
      }

      const entry = resolved.entry;
      const nextValue = typeof value === 'boolean'
        ? (value ? entry.targetValue : entry.defaultValue)
        : value;
      applyEntryValue(entry, nextValue, durationSec);
      bump();
      return { success: true, state: toState(entry) };
    },

    activate(name, value = true, durationSec) {
      return get().set(name, value, durationSec);
    },

    deactivate(name) {
      const resolved = get().resolve(name);
      if (!resolved) return notFound(name, get());

      if (resolved.kind === 'group') {
        const states: ExpressionState[] = [];
        for (const param of resolved.group.parameters) {
          const entry = get().expressions.get(param.parameterId);
          if (!entry) continue;
          applyEntryValue(entry, entry.defaultValue);
          states.push(toState(entry));
        }
        bump();
        return { success: true, state: states };
      }

      applyEntryValue(resolved.entry, resolved.entry.defaultValue);
      bump();
      return { success: true, state: toState(resolved.entry) };
    },

    get(name) {
      const state = get();
      if (!name) {
        return { success: true, state: Array.from(state.expressions.values()).map(toState) };
      }

      const resolved = state.resolve(name);
      if (!resolved) return notFound(name, state);

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

    toggle(name, durationSec) {
      const resolved = get().resolve(name);
      if (!resolved) return notFound(name, get());

      if (resolved.kind === 'group') {
        const isActive = resolved.group.parameters.some((param) => {
          const entry = get().expressions.get(param.parameterId);
          return entry !== undefined && entry.currentValue !== entry.defaultValue;
        });
        return isActive ? get().deactivate(name) : get().activate(name, true, durationSec);
      }

      const entry = resolved.entry;
      const active = entry.currentValue !== entry.defaultValue;
      return active ? get().deactivate(name) : get().activate(name, true, durationSec);
    },

    saveDefaults() {
      const state = get();
      if (!state.modelId) return { success: false, error: 'No model loaded' };

      const defaults: Record<string, number> = {};
      for (const [name, entry] of state.expressions) {
        entry.defaultValue = entry.currentValue;
        defaults[name] = entry.currentValue;
      }
      savePersistedDefaults(state.modelId, defaults);
      bump();
      return { success: true };
    },

    resetAll() {
      const states: ExpressionState[] = [];
      for (const entry of get().expressions.values()) {
        applyEntryValue(entry, entry.defaultValue);
        states.push(toState(entry));
      }
      bump();
      return { success: true, state: states };
    },

    dispose() {
      clearAllTimers(get().expressions);
      set({ ...initial });
    },
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function clearTimer(entry: ExpressionEntry): void {
  if (entry.resetTimer !== undefined) {
    clearTimeout(entry.resetTimer);
    entry.resetTimer = undefined;
  }
  entry.resetAt = undefined;
}

function clearAllTimers(map: Map<string, ExpressionEntry>): void {
  for (const entry of map.values()) clearTimer(entry);
}

function toState(entry: ExpressionEntry): ExpressionState {
  const state: ExpressionState = {
    name: entry.name,
    value: entry.currentValue,
    default: entry.defaultValue,
    active: entry.currentValue !== entry.defaultValue,
  };
  if (entry.resetAt !== undefined) state.autoResetAt = entry.resetAt;
  return state;
}

function availableNames(state: ExpressionStoreState): string[] {
  return [
    ...Array.from(state.expressionGroups.keys()),
    ...Array.from(state.expressions.keys()),
  ];
}

function notFound(name: string, state: ExpressionStoreState): ExpressionToolResult {
  return {
    success: false,
    error: `Expression "${name}" not found`,
    available: availableNames(state),
  };
}

// 保存单个 Live2D 舞台解析后的表情参数与实时取值。
import { create, type StoreApi, type UseBoundStore } from 'zustand';

// ── Live2D expression store ─────────────────────────────────────────────────
//
// Internal runtime store — do NOT call set/activate/deactivate/toggle from
// UI or Agent tools directly. All intent changes must go through useLive2DStore.
// Live2DStage is the only reconciler from intent → expression runtime values.
//
// Stores expression data after .exp3.json has been parsed. It does not fetch
// model files and it does not render. expressionController reads this store
// every frame and applies currentValue to the Cubism coreModel.
//
// Duration/lifecycle: owned entirely by live2dStore (via expressionTimers).
// This store only tracks the current parameter values — no timers here.

// ── Types ───────────────────────────────────────────────────────────────────

export type ExpressionBlendMode = 'Add' | 'Multiply' | 'Overwrite';

export interface ExpressionEntry {
  /** Human-readable name (same as parameterId in current usage). */
  name:         string;
  /** Live2D parameter ID, e.g. ParamMouthForm. */
  parameterId:  string;
  blend:        ExpressionBlendMode;
  /** Runtime value applied by expression-controller every frame. */
  currentValue: number;
  /** Application-level default; may be persisted per model. */
  defaultValue: number;
  /** Model-baked default read from Cubism when possible. */
  modelDefault: number;
  /** Activation value from exp3. */
  targetValue:  number;
}

export interface ExpressionGroupParam {
  parameterId: string;
  blend:       ExpressionBlendMode;
  value:       number;
}

export interface ExpressionGroupDefinition {
  name:       string;
  parameters: ExpressionGroupParam[];
}

export interface ExpressionState {
  name:    string;
  value:   number;
  default: number;
  active:  boolean;
}

export interface ExpressionToolResult {
  success:    boolean;
  error?:     string;
  state?:     ExpressionState | ExpressionState[];
  available?: string[];
}

interface ExpressionStoreState {
  /** Map<parameterId, entry>. */
  expressions:      Map<string, ExpressionEntry>;
  /** Map<expressionName, groupDef>. */
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
  set(name: string, value: boolean | number): ExpressionToolResult;
  activate(name: string, value?: boolean | number): ExpressionToolResult;
  deactivate(name: string): ExpressionToolResult;
  get(name?: string): ExpressionToolResult;
  toggle(name: string): ExpressionToolResult;
  saveDefaults(): ExpressionToolResult;
  resetAll(): ExpressionToolResult;
  dispose(): void;
}

export type ExpressionStore = ExpressionStoreState & ExpressionStoreActions;
export type ExpressionStoreApi = UseBoundStore<StoreApi<ExpressionStore>>;

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

export function createExpressionStore(): ExpressionStoreApi {
  return create<ExpressionStore>((set, get) => {
  const bump = (): void => {
    set((s) => ({ expressions: new Map(s.expressions) }));
  };

  // Set entry.currentValue and trigger a re-render. No timer logic —
  // duration is owned by live2dStore.
  const applyEntryValue = (entry: ExpressionEntry, value: number): void => {
    entry.currentValue = value;
  };

  const applyGroup = (
    group: ExpressionGroupDefinition,
    value: boolean | number,
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

      applyEntryValue(entry, nextValue);
      states.push(toState(entry));
    }
    return states;
  };

  return {
    ...initial,

    registerExpressions(modelId, groups, entries) {
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

    set(name, value) {
      const resolved = get().resolve(name);
      if (!resolved) return notFound(name, get());

      if (resolved.kind === 'group') {
        const states = applyGroup(resolved.group, value);
        bump();
        return { success: true, state: states };
      }

      const entry     = resolved.entry;
      const nextValue = typeof value === 'boolean'
        ? (value ? entry.targetValue : entry.defaultValue)
        : value;
      applyEntryValue(entry, nextValue);
      bump();
      return { success: true, state: toState(entry) };
    },

    activate(name, value = true) {
      return get().set(name, value);
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

    toggle(name) {
      const resolved = get().resolve(name);
      if (!resolved) return notFound(name, get());

      if (resolved.kind === 'group') {
        const isActive = resolved.group.parameters.some((param) => {
          const entry = get().expressions.get(param.parameterId);
          return entry !== undefined && entry.currentValue !== entry.defaultValue;
        });
        return isActive ? get().deactivate(name) : get().activate(name, true);
      }

      const entry  = resolved.entry;
      const active = entry.currentValue !== entry.defaultValue;
      return active ? get().deactivate(name) : get().activate(name, true);
    },

    saveDefaults() {
      const state = get();
      if (!state.modelId) return { success: false, error: 'No model loaded' };

      const defaults: Record<string, number> = {};
      for (const [name, entry] of state.expressions) {
        entry.defaultValue = entry.currentValue;
        defaults[name]     = entry.currentValue;
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
      set({ ...initial });
    },
    };
  });
}

export const useExpressionStore = createExpressionStore();

// ── Helpers ─────────────────────────────────────────────────────────────────

function toState(entry: ExpressionEntry): ExpressionState {
  return {
    name:    entry.name,
    value:   entry.currentValue,
    default: entry.defaultValue,
    active:  entry.currentValue !== entry.defaultValue,
  };
}

function availableNames(state: ExpressionStoreState): string[] {
  return [
    ...Array.from(state.expressionGroups.keys()),
    ...Array.from(state.expressions.keys()),
  ];
}

function notFound(name: string, state: ExpressionStoreState): ExpressionToolResult {
  return {
    success:   false,
    error:     `Expression "${name}" not found`,
    available: availableNames(state),
  };
}

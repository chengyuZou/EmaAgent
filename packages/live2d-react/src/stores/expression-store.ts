// 保存单个 Live2D 舞台解析后的表情参数与实时取值。
import { create, type StoreApi, type UseBoundStore } from 'zustand';

// ── Live2D expression store ─────────────────────────────────────────────────
//
// Internal runtime store — do NOT call set/activate/deactivate/toggle from
// UI or Agent tools directly. All intent changes must go through useLive2DStore.
// Live2DStage is the only reconciler from intent → expression runtime values.
//
// Stores expression definitions and per-source contributions after .exp3.json
// has been parsed. It does not fetch model files and it does not render.
// expressionController composes active contributions onto each frame's base.
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

export interface ExpressionContribution {
  sourceKey: string;
  sourceName: string;
  parameterId: string;
  blend: ExpressionBlendMode;
  value: number;
  /** 数值越大越晚合成；V1 内置来源均为 0。 */
  priority: number;
  /** 同优先级按激活顺序合成，后激活的 Overwrite 最终生效。 */
  sequence: number;
  /** 同一 exp3 内保持参数声明顺序。 */
  order: number;
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
  /** Map<sourceKey, contributions>，停用来源时只删除自己的贡献。 */
  contributions: Map<string, ExpressionContribution[]>;
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
  set(name: string, value: boolean | number, priority?: number): ExpressionToolResult;
  activate(name: string, value?: boolean | number, priority?: number): ExpressionToolResult;
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
  contributions:    new Map(),
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
  let activationSequence = 0;

  return create<ExpressionStore>((set, get) => {
    const sourceKey = (
      name: string,
      kind: 'group' | 'param',
    ): string => `${kind}:${name}`;

    const contributionsForParameter = (
      state: ExpressionStoreState,
      parameterId: string,
    ): ExpressionContribution[] => Array.from(state.contributions.values())
      .flat()
      .filter((item) => item.parameterId === parameterId)
      .sort(compareContributions);

    // Store 中的 currentValue 是 UI/工具查询投影；真实渲染仍由 Controller
    // 使用本帧 motion/blink 基值重新合成，二者职责不能混用。
    const refreshProjectedValues = (
      expressions: Map<string, ExpressionEntry>,
      contributions: Map<string, ExpressionContribution[]>,
    ): void => {
      const projectionState: ExpressionStoreState = {
        expressions,
        expressionGroups: get().expressionGroups,
        contributions,
        modelId: get().modelId,
      };
      for (const entry of expressions.values()) {
        entry.currentValue = composeContributionValues(
          entry.defaultValue,
          contributionsForParameter(projectionState, entry.parameterId),
        );
      }
    };

    const publishContributions = (
      nextContributions: Map<string, ExpressionContribution[]>,
    ): void => {
      const nextExpressions = cloneExpressions(get().expressions);
      refreshProjectedValues(nextExpressions, nextContributions);
      set({
        expressions: nextExpressions,
        contributions: nextContributions,
      });
    };

    const statesForGroup = (
      group: ExpressionGroupDefinition,
      active: boolean,
    ): ExpressionState[] => group.parameters.flatMap((param) => {
      const entry = get().expressions.get(param.parameterId);
      return entry ? [toState(entry, active)] : [];
    });

    return {
      ...initial,

      registerExpressions(modelId, groups, entries) {
        activationSequence = 0;
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

        set({
          expressions,
          expressionGroups,
          contributions: new Map(),
          modelId,
        });
      },

      resolve(name) {
        const state = get();
        const group = state.expressionGroups.get(name);
        if (group) return { kind: 'group', group };
        const entry = state.expressions.get(name);
        if (entry) return { kind: 'param', entry };
        return null;
      },

      set(name, value, priority = 0) {
        const resolved = get().resolve(name);
        if (!resolved) return notFound(name, get());
        if (value === false) return get().deactivate(name);

        activationSequence += 1;
        const sequence = activationSequence;
        const nextContributions = new Map(get().contributions);

        if (resolved.kind === 'group') {
          const key = sourceKey(name, 'group');
          const multiplier = typeof value === 'number' ? value : 1;
          const contributions = resolved.group.parameters.map((param, order) => ({
            sourceKey: key,
            sourceName: name,
            parameterId: param.parameterId,
            blend: param.blend,
            value: param.value * multiplier,
            priority,
            sequence,
            order,
          }));
          nextContributions.set(key, contributions);
          publishContributions(nextContributions);
          return { success: true, state: statesForGroup(resolved.group, true) };
        }

        const key = sourceKey(name, 'param');
        const nextValue = typeof value === 'boolean'
          ? resolved.entry.targetValue
          : value;
        nextContributions.set(key, [{
          sourceKey: key,
          sourceName: name,
          parameterId: resolved.entry.parameterId,
          blend: resolved.entry.blend,
          value: nextValue,
          priority,
          sequence,
          order: 0,
        }]);
        publishContributions(nextContributions);
        return { success: true, state: toState(get().expressions.get(name)!, true) };
      },

      activate(name, value = true, priority = 0) {
        return get().set(name, value, priority);
      },

      deactivate(name) {
        const resolved = get().resolve(name);
        if (!resolved) return notFound(name, get());

        const kind = resolved.kind === 'group' ? 'group' : 'param';
        const key = sourceKey(name, kind);
        const nextContributions = new Map(get().contributions);
        nextContributions.delete(key);
        publishContributions(nextContributions);

        if (resolved.kind === 'group') {
          return { success: true, state: statesForGroup(resolved.group, false) };
        }
        return {
          success: true,
          state: toState(get().expressions.get(resolved.entry.parameterId)!, false),
        };
      },

      get(name) {
        const state = get();
        if (!name) {
          const activeParameters = new Set(
            Array.from(state.contributions.values()).flat().map((item) => item.parameterId),
          );
          return {
            success: true,
            state: Array.from(state.expressions.values()).map((entry) => (
              toState(entry, activeParameters.has(entry.parameterId))
            )),
          };
        }

        const resolved = state.resolve(name);
        if (!resolved) return notFound(name, state);
        if (resolved.kind === 'group') {
          const active = state.contributions.has(sourceKey(name, 'group'));
          return { success: true, state: statesForGroup(resolved.group, active) };
        }

        const active = state.contributions.has(sourceKey(name, 'param'));
        return { success: true, state: toState(resolved.entry, active) };
      },

      toggle(name) {
        const resolved = get().resolve(name);
        if (!resolved) return notFound(name, get());
        const kind = resolved.kind === 'group' ? 'group' : 'param';
        const active = get().contributions.has(sourceKey(name, kind));
        return active ? get().deactivate(name) : get().activate(name, true);
      },

      saveDefaults() {
        const state = get();
        if (!state.modelId) return { success: false, error: 'No model loaded' };

        const defaults: Record<string, number> = {};
        const expressions = cloneExpressions(state.expressions);
        for (const [name, entry] of expressions) {
          entry.defaultValue = entry.currentValue;
          defaults[name] = entry.currentValue;
        }
        savePersistedDefaults(state.modelId, defaults);
        set({ expressions, contributions: new Map() });
        return { success: true };
      },

      resetAll() {
        const expressions = cloneExpressions(get().expressions);
        const states: ExpressionState[] = [];
        for (const entry of expressions.values()) {
          entry.currentValue = entry.defaultValue;
          states.push(toState(entry, false));
        }
        set({ expressions, contributions: new Map() });
        return { success: true, state: states };
      },

      dispose() {
        activationSequence = 0;
        set({ ...initial });
      },
    };
  });
}

export const useExpressionStore = createExpressionStore();

// ── Helpers ─────────────────────────────────────────────────────────────────

function toState(entry: ExpressionEntry, active: boolean): ExpressionState {
  return {
    name:    entry.name,
    value:   entry.currentValue,
    default: entry.defaultValue,
    active,
  };
}

function cloneExpressions(
  expressions: Map<string, ExpressionEntry>,
): Map<string, ExpressionEntry> {
  return new Map(
    Array.from(expressions, ([parameterId, entry]) => [parameterId, { ...entry }]),
  );
}

export function compareContributions(
  left: ExpressionContribution,
  right: ExpressionContribution,
): number {
  return left.priority - right.priority
    || left.sequence - right.sequence
    || left.order - right.order
    || left.sourceKey.localeCompare(right.sourceKey);
}

export function composeContributionValues(
  baseValue: number,
  contributions: ExpressionContribution[],
): number {
  let value = baseValue;
  for (const contribution of [...contributions].sort(compareContributions)) {
    switch (contribution.blend) {
      case 'Add':
        value += contribution.value;
        break;
      case 'Multiply':
        value *= contribution.value;
        break;
      case 'Overwrite':
        value = contribution.value;
        break;
    }
  }
  return value;
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

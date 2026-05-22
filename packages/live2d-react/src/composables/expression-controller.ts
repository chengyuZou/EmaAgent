import {
  useExpressionStore,
  type ExpressionEntry,
  type ExpressionBlendMode,
  type ExpressionGroupDefinition,
} from '../stores/expression-store.js';

// ── Live2D expression controller ────────────────────────────────────────────
//
// Two responsibilities:
//   1. Parse exp3.json files at model load, populate the expression store
//   2. Per-frame: apply current entry values to the Live2D model with proper
//      blend math + noop detection + active-to-inactive transition reset
//
// Ported from AIRI's stage-ui-live2d/composables/live2d/expression-controller.ts.
// Vue Refs → closures over the getter passed in at create time.

// ── Types for exp3.json data ────────────────────────────────────────────────

interface Model3ExpressionRef {
  Name: string;
  File: string;
}

interface Exp3Parameter {
  Id:    string;
  Value: number;
  Blend: 'Add' | 'Multiply' | 'Overwrite';
}

interface Exp3Json {
  Type: string;
  Parameters: Exp3Parameter[];
}

/** Subset of pixi-live2d-display's InternalModel we care about. */
export interface CoreModelLike {
  getParameterValueById(id: string): number;
  setParameterValueById(id: string, value: number): void;
  /** Optional Cubism 4+ API for reading bake-in defaults. */
  getParameterDefaultValueById?(id: string): number;
}

export interface ExpressionControllerOptions {
  /** Lazy accessor — controller may be created before the model loads. */
  getCoreModel(): CoreModelLike | undefined;
  modelId?: string;
}

export interface ExpressionController {
  /**
   * Parse exp3 references + register entries in the store. Idempotent —
   * call again on model swap with the new refs.
   *
   * @param expressionRefs  Entries from model3.json `FileReferences.Expressions`
   * @param readExpFile     Async reader for exp3 file contents (path relative
   *                        to the model root). For HTTP-hosted models pass a
   *                        function that fetches the URL.
   */
  initialise(
    expressionRefs: Model3ExpressionRef[],
    readExpFile:   (path: string) => Promise<string>,
    modelBaseUrl?: string,
  ): Promise<void>;

  /**
   * Apply all current expression entries onto the core model. Call every
   * frame from the motion-manager final-stage plugin.
   */
  applyExpressions(coreModel: CoreModelLike): void;

  /** Reset everything. Call on model unmount. */
  dispose(): void;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an expression controller bound to a specific model. Stateful but no
 * React internals — works anywhere.
 *
 * Use when:
 * - A Live2D model has finished loading and you want exp3-based expressions
 *
 * Expects:
 * - `getCoreModel()` may return undefined before load; the controller probes
 *   each call
 *
 * Returns:
 * - { initialise, applyExpressions, dispose }
 */
export function createExpressionController(opts: ExpressionControllerOptions): ExpressionController {
  // Track which parameter IDs we wrote last frame so we can detect the
  // active→inactive transition (e.g. expression toggled off) and explicitly
  // restore modelDefault. Expression-only params aren't reset by motion.
  const activeLastFrame = new Set<string>();

  return {
    async initialise(expressionRefs, readExpFile, modelBaseUrl) {
      const groups: ExpressionGroupDefinition[] = [];
      const entryMap = new Map<string, ExpressionEntry>();

      for (const ref of expressionRefs) {
        try {
          const path = modelBaseUrl ? joinUrl(modelBaseUrl, ref.File) : ref.File;
          const raw  = await readExpFile(path);
          const exp3: Exp3Json = JSON.parse(raw);

          const groupParams: ExpressionGroupDefinition['parameters'] = [];

          for (const param of exp3.Parameters) {
            const blend = normaliseBlend(param.Blend);
            groupParams.push({
              parameterId: param.Id,
              blend,
              value:       param.Value,
            });

            if (!entryMap.has(param.Id)) {
              const modelDefault = readModelDefault(opts.getCoreModel(), param.Id);
              entryMap.set(param.Id, {
                name:         param.Id,
                parameterId:  param.Id,
                blend,
                currentValue: modelDefault,
                defaultValue: modelDefault,
                modelDefault,
                targetValue:  param.Value,
              });
            } else if (param.Value !== 0) {
              // Prefer non-zero activation value (first-write wins for zero,
              // but later non-zero overrides). Matches AIRI semantics.
              const existing = entryMap.get(param.Id)!;
              if (existing.targetValue === 0) existing.targetValue = param.Value;
            }
          }

          groups.push({ name: ref.Name, parameters: groupParams });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[expression-controller] failed to load exp3 "${ref.Name}" (${ref.File}):`, err);
        }
      }

      useExpressionStore.getState().registerExpressions(
        opts.modelId ?? 'unknown',
        groups,
        Array.from(entryMap.values()),
      );
    },

    applyExpressions(coreModel) {
      const activeThisFrame = new Set<string>();
      const expressions = useExpressionStore.getState().expressions;

      for (const entry of expressions.values()) {
        if (isNoopValue(entry)) continue;
        const blended = computeBlendedValue(entry, coreModel);
        coreModel.setParameterValueById(entry.parameterId, blended);
        activeThisFrame.add(entry.parameterId);
      }

      // active→inactive transition reset
      for (const paramId of activeLastFrame) {
        if (!activeThisFrame.has(paramId)) {
          const entry = findEntryByParameterId(paramId);
          if (entry) coreModel.setParameterValueById(paramId, entry.modelDefault);
        }
      }

      activeLastFrame.clear();
      for (const id of activeThisFrame) activeLastFrame.add(id);
    },

    dispose() {
      activeLastFrame.clear();
      useExpressionStore.getState().dispose();
    },
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────

function normaliseBlend(raw: string): ExpressionBlendMode {
  switch (raw) {
    case 'Add':      return 'Add';
    case 'Multiply': return 'Multiply';
    default:         return 'Overwrite';
  }
}

/**
 * Does this entry contribute nothing visually?
 *   Add:       currentValue === 0 (additive identity)
 *   Multiply:  currentValue === 1 (multiplicative identity)
 *   Overwrite: currentValue === modelDefault (no change)
 */
function isNoopValue(entry: ExpressionEntry): boolean {
  switch (entry.blend) {
    case 'Add':      return entry.currentValue === 0;
    case 'Multiply': return entry.currentValue === 1;
    default:         return entry.currentValue === entry.modelDefault;
  }
}

/**
 * Compute final blended value for one parameter.
 *
 *   Add:       modelDefault + currentValue (stable base — expression-only
 *              params aren't reset by motion, so we can't read "current frame
 *              value" as base or values would accumulate forever)
 *   Multiply:  currentFrameValue * currentValue (preserves blink/motion)
 *   Overwrite: currentValue (direct replacement)
 */
function computeBlendedValue(entry: ExpressionEntry, coreModel: CoreModelLike): number {
  switch (entry.blend) {
    case 'Add':
      return entry.modelDefault + entry.currentValue;
    case 'Multiply': {
      const current = coreModel.getParameterValueById(entry.parameterId);
      return current * entry.currentValue;
    }
    default:
      return entry.currentValue;
  }
}

function findEntryByParameterId(paramId: string): ExpressionEntry | undefined {
  for (const entry of useExpressionStore.getState().expressions.values()) {
    if (entry.parameterId === paramId) return entry;
  }
  return undefined;
}

function readModelDefault(model: CoreModelLike | undefined, paramId: string): number {
  if (!model) return 0;
  try {
    if (typeof model.getParameterDefaultValueById === 'function') {
      const v = model.getParameterDefaultValueById(paramId);
      if (v !== null && v !== undefined) return v;
    }
    return model.getParameterValueById(paramId);
  } catch {
    return 0;
  }
}

function joinUrl(base: string, rel: string): string {
  if (rel.startsWith('/') || /^https?:/.test(rel)) return rel;
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}/${rel}`;
}

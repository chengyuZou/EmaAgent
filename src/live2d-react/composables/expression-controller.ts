// 解析表情文件并把指定舞台的表情参数应用到 Cubism 模型。
import {
  compareContributions,
  composeContributionValues,
  type ExpressionEntry,
  type ExpressionBlendMode,
  type ExpressionContribution,
  type ExpressionGroupDefinition,
  type ExpressionStoreApi,
} from '../stores/expression-store.js';

// ── Live2D expression controller ────────────────────────────────────────────
//
// Two responsibilities:
//   1. Parse exp3.json files at model load, populate the expression store
//   2. Per-frame: reset previous writes, then compose all active sources with
//      their own Blend mode onto the native motion/blink values
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
  expressionStore: ExpressionStoreApi;
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
  ): Promise<string[]>;

  /** 在原生 motion/blink 前清除上一帧 expression 写入。 */
  prepareFrame(coreModel: CoreModelLike): void;

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

      // 表情文件彼此独立，最多同时读取四个，避免大模型串行等待或瞬间打爆资源协议。
      const loaded = await loadExpressions(expressionRefs, readExpFile, modelBaseUrl, 4);
      for (const result of loaded) {
        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.warn(
            `[expression-controller] failed to load exp3 "${result.ref.Name}" (${result.ref.File}):`,
            result.error,
          );
          continue;
        }

        const groupParams: ExpressionGroupDefinition['parameters'] = [];
        for (const param of result.expression.Parameters) {
          const blend = normaliseBlend(param.Blend);
          groupParams.push({ parameterId: param.Id, blend, value: param.Value });

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
            const existing = entryMap.get(param.Id)!;
            if (existing.targetValue === 0) existing.targetValue = param.Value;
          }
        }

        groups.push({ name: result.ref.Name, parameters: groupParams });
      }

      opts.expressionStore.getState().registerExpressions(
        opts.modelId ?? 'unknown',
        groups,
        Array.from(entryMap.values()),
      );
      return groups.map((group) => group.name);
    },

    prepareFrame(coreModel) {
      const expressions = opts.expressionStore.getState().expressions;
      for (const paramId of activeLastFrame) {
        const entry = expressions.get(paramId);
        if (entry) coreModel.setParameterValueById(paramId, entry.defaultValue);
      }
      activeLastFrame.clear();
    },

    applyExpressions(coreModel) {
      const state = opts.expressionStore.getState();
      const byParameter = new Map<string, ExpressionContribution[]>();
      for (const contribution of Array.from(state.contributions.values()).flat()) {
        const bucket = byParameter.get(contribution.parameterId) ?? [];
        bucket.push(contribution);
        byParameter.set(contribution.parameterId, bucket);
      }

      for (const [parameterId, contributions] of byParameter) {
        const baseValue = coreModel.getParameterValueById(parameterId);
        const blended = composeContributionValues(
          baseValue,
          contributions.sort(compareContributions),
        );
        coreModel.setParameterValueById(parameterId, blended);
        activeLastFrame.add(parameterId);
      }
    },

    dispose() {
      activeLastFrame.clear();
      opts.expressionStore.getState().dispose();
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

interface LoadedExpression {
  ok: true;
  ref: Model3ExpressionRef;
  expression: Exp3Json;
}

interface FailedExpression {
  ok: false;
  ref: Model3ExpressionRef;
  error: unknown;
}

type ExpressionLoadResult = LoadedExpression | FailedExpression;

async function loadExpressions(
  refs: Model3ExpressionRef[],
  readExpFile: (path: string) => Promise<string>,
  modelBaseUrl: string | undefined,
  concurrency: number,
): Promise<ExpressionLoadResult[]> {
  const results = new Array<ExpressionLoadResult>(refs.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < refs.length) {
      const index = nextIndex++;
      const ref = refs[index]!;
      try {
        validateExpressionRef(ref);
        const path = modelBaseUrl ? joinUrl(modelBaseUrl, ref.File) : ref.File;
        const raw = await readExpFile(path);
        results[index] = { ok: true, ref, expression: parseExp3(raw) };
      } catch (error) {
        results[index] = { ok: false, ref, error };
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), refs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function validateExpressionRef(ref: Model3ExpressionRef): void {
  if (!ref.Name?.trim() || !ref.File?.trim()) {
    throw new Error('exp3 reference requires non-empty Name and File');
  }
}

function parseExp3(raw: string): Exp3Json {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || !Array.isArray(value.Parameters)) {
    throw new Error('exp3 Parameters must be an array');
  }

  const parameters = value.Parameters.map((parameter, index): Exp3Parameter => {
    if (!isRecord(parameter)) throw new Error(`exp3 Parameters[${index}] must be an object`);
    const id = typeof parameter.Id === 'string' ? parameter.Id.trim() : '';
    if (!id) throw new Error(`exp3 Parameters[${index}].Id must be a non-empty string`);
    if (typeof parameter.Value !== 'number' || !Number.isFinite(parameter.Value)) {
      throw new Error(`exp3 Parameters[${index}].Value must be finite`);
    }
    if (!isBlendMode(parameter.Blend)) {
      throw new Error(`exp3 Parameters[${index}].Blend is unsupported`);
    }
    return { Id: id, Value: parameter.Value, Blend: parameter.Blend };
  });

  return {
    Type: typeof value.Type === 'string' ? value.Type : 'Live2D Expression',
    Parameters: parameters,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlendMode(value: unknown): value is Exp3Parameter['Blend'] {
  return value === 'Add' || value === 'Multiply' || value === 'Overwrite';
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

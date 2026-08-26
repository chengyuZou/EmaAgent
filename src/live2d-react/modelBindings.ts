// 把 Character 给出的 ID 和 Motion 引用绑定到当前 Cubism 模型的真实对象。

import type { Cubism4InternalModel } from 'pixi-live2d-display/cubism4';
import type {
  Live2DModelBindings,
  Live2DMotionReference,
} from './types.js';

export interface ResolvedLive2DLipSyncParameter {
  index: number;
  closedValue: number;
  openValue: number;
}

export interface ResolvedLive2DModelBindings {
  idleMotions: readonly Live2DMotionReference[];
  lipSyncParameters: readonly ResolvedLive2DLipSyncParameter[];
}

/**
 * Cubism `getParameterIndex()` 会为未知 ID 创建虚拟参数，所以先用 Core 真实 ID 过滤。
 * Motion 也在模型加载后绑定，避免待机调度反复请求不存在的动作。
 */
export function resolveLive2DModelBindings(
  internalModel: Cubism4InternalModel,
  bindings?: Live2DModelBindings,
): ResolvedLive2DModelBindings {
  const coreModel = internalModel.coreModel;
  const parameters = coreModel.getModel().parameters;
  const parameterIds = new Set(parameters.ids);
  const requestedLipSyncIds = bindings?.lipSyncParameterIds
    ?? internalModel.settings.getLipSyncParameters()
    ?? [];

  const lipSyncParameters = uniqueNonEmpty(requestedLipSyncIds).flatMap((id) => {
    if (!parameterIds.has(id)) return [];
    const index = coreModel.getParameterIndex(id);
    const minimum = coreModel.getParameterMinimumValue(index);
    const maximum = coreModel.getParameterMaximumValue(index);
    return [{
      index,
      closedValue: clamp(0, minimum, maximum),
      openValue: maximum,
    }];
  });

  return {
    idleMotions: resolveMotionReferences(
      internalModel.motionManager.definitions,
      bindings?.idleMotions ?? [],
    ),
    lipSyncParameters,
  };
}

function resolveMotionReferences(
  definitions: Readonly<Partial<Record<string, readonly unknown[]>>>,
  references: readonly Live2DMotionReference[],
): Live2DMotionReference[] {
  const seen = new Set<string>();
  const resolved: Live2DMotionReference[] = [];

  for (const reference of references) {
    const group = reference.group.trim();
    const motions = definitions[group];
    if (!group || !motions?.length) continue;
    if (reference.index !== undefined
      && (!Number.isInteger(reference.index)
        || reference.index < 0
        || reference.index >= motions.length)) {
      continue;
    }

    const key = `${group}:${reference.index ?? '*'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({
      group,
      ...(reference.index === undefined ? {} : { index: reference.index }),
    });
  }

  return resolved;
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

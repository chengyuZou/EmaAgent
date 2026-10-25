import type { CubismInternalModel } from '@laplace.live/pixijs-live2d';

export interface ResolvedLive2DLipSyncParameter {
  index: number;
  closedValue: number;
  openValue: number;
}

/**
 * Cubism getParameterIndex() 会为未知 ID 创建虚拟参数, 因此先按模型真实 ID 过滤.
 */
export function resolveLive2DLipSyncParameters(
  internalModel: CubismInternalModel,
): ResolvedLive2DLipSyncParameter[] {
  const coreModel = internalModel.coreModel;
  const parameters = coreModel.getModel().parameters;
  const parameterIds = new Set(parameters.ids);
  const requestedLipSyncIds = internalModel.settings.getLipSyncParameters() ?? [];

  return uniqueNonEmpty(requestedLipSyncIds).flatMap((id) => {
    if (!parameterIds.has(id)) return [];
    const index = parameters.ids.indexOf(id);
    const minimum = coreModel.getParameterMinimumValue(index);
    const maximum = coreModel.getParameterMaximumValue(index);
    return [{
      index,
      closedValue: clamp(0, minimum, maximum),
      openValue: maximum,
    }];
  });
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

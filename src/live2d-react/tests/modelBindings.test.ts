import type { CubismInternalModel } from '@laplace.live/pixijs-live2d';
import { describe, expect, it } from 'vitest';
import { resolveLive2DLipSyncParameters } from '../modelBindings.js';

function internalModel(
  ids: readonly string[],
  lipSyncIds: readonly string[],
): CubismInternalModel {
  return {
    coreModel: {
      getModel: () => ({ parameters: { ids } }),
      getParameterMinimumValue: () => 0,
      getParameterMaximumValue: () => 2,
    },
    settings: {
      getLipSyncParameters: () => [...lipSyncIds],
    },
  } as unknown as CubismInternalModel;
}

describe('resolveLive2DLipSyncParameters', () => {
  it('使用模型 LipSync group, 并映射到参数真实范围', () => {
    const resolved = resolveLive2DLipSyncParameters(
      internalModel(['ParamMouthOpenY'], ['ParamMouthOpenY']),
    );

    expect(resolved).toEqual([{
      index: 0,
      closedValue: 0,
      openValue: 2,
    }]);
  });

  it('过滤模型未实际包含的 ID 和重复登记', () => {
    const resolved = resolveLive2DLipSyncParameters(
      internalModel(['Mouth'], ['Mouth', 'Missing', 'Mouth']),
    );

    expect(resolved).toEqual([{
      index: 0,
      closedValue: 0,
      openValue: 2,
    }]);
  });
});

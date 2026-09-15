// 测试口型绑定只采用 model3.json 登记且 Cubism Core 真实存在的 Parameter。

import type { Cubism4InternalModel } from 'pixi-live2d-display/cubism4';
import { describe, expect, it } from 'vitest';
import { resolveLive2DLipSyncParameters } from '../modelBindings.js';

function internalModel(
  ids: readonly string[],
  lipSyncIds: readonly string[],
): Cubism4InternalModel {
  return {
    coreModel: {
      getModel: () => ({ parameters: { ids } }),
      getParameterIndex: (id: string) => ids.indexOf(id),
      getParameterMinimumValue: () => 0,
      getParameterMaximumValue: () => 2,
    },
    settings: {
      getLipSyncParameters: () => [...lipSyncIds],
    },
  } as unknown as Cubism4InternalModel;
}

describe('resolveLive2DLipSyncParameters', () => {
  it('使用模型 LipSync group，并映射到参数真实范围', () => {
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

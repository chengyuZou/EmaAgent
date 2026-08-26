// 测试播放绑定只保留当前 Cubism 模型真实存在的 Parameter 与 Motion。

import type { Cubism4InternalModel } from 'pixi-live2d-display/cubism4';
import { describe, expect, it } from 'vitest';
import { resolveLive2DModelBindings } from '../modelBindings.js';

function internalModel(
  ids: readonly string[],
  lipSyncIds: readonly string[],
  motions: Record<string, readonly unknown[]>,
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
    motionManager: { definitions: motions },
  } as unknown as Cubism4InternalModel;
}

describe('resolveLive2DModelBindings', () => {
  it('未显式绑定时使用模型 LipSync group，但不猜待机 Motion', () => {
    const resolved = resolveLive2DModelBindings(
      internalModel(['ParamMouthOpenY'], ['ParamMouthOpenY'], { Idle: [{}, {}] }),
    );

    expect(resolved.lipSyncParameters).toEqual([{
      index: 0,
      closedValue: 0,
      openValue: 2,
    }]);
    expect(resolved.idleMotions).toEqual([]);
  });

  it('空数组关闭口型，并过滤未知 ID、越界 Motion 和重复引用', () => {
    const resolved = resolveLive2DModelBindings(
      internalModel(['Mouth'], ['Mouth'], { Idle: [{}, {}], Wave: [{}] }),
      {
        lipSyncParameterIds: [],
        idleMotions: [
          { group: 'Idle', index: 1 },
          { group: 'Idle', index: 1 },
          { group: 'Idle', index: 2 },
          { group: 'Missing' },
          { group: 'Wave' },
        ],
      },
    );

    expect(resolved.lipSyncParameters).toEqual([]);
    expect(resolved.idleMotions).toEqual([
      { group: 'Idle', index: 1 },
      { group: 'Wave' },
    ]);
  });
});

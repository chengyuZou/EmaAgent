// 测试 motion pipeline 向插件提供毫秒时间，同时给 Cubism 原生 blink 传秒。
import { describe, expect, it, vi } from 'vitest';
import {
  createIdleDisablePlugin,
  createMotionManagerUpdate,
  type CubismCoreLike,
  type InternalModelForPlugins,
} from '../src/composables/motion-manager.js';

function createRuntime() {
  const values = new Map<string, number>();
  const model: CubismCoreLike = {
    getParameterValueById: (id) => values.get(id) ?? 1,
    setParameterValueById: (id, value) => { values.set(id, value); },
  };
  const updateParameters = vi.fn();
  const internalModel: InternalModelForPlugins = {
    coreModel: model,
    motionManager: {
      state: { currentGroup: undefined },
      groups: { idle: 'Idle' },
      stopAllMotions: vi.fn(),
      update: vi.fn(() => false),
    },
    eyeBlink: { updateParameters },
  };
  const pipeline = createMotionManagerUpdate({
    internalModel,
    readModelParameters: () => ({ leftEyeOpen: 1, rightEyeOpen: 1 }),
    readFlags: () => ({
      idleAnimationEnabled: false,
      autoBlinkEnabled: true,
      forceAutoBlinkEnabled: false,
    }),
  });
  return { model, pipeline, updateParameters };
}

describe('motion pipeline 时间契约', () => {
  it('插件统一收到毫秒，并对长卡顿执行 100ms 钳制', () => {
    const { model, pipeline } = createRuntime();
    const seen: number[] = [];
    pipeline.register((context) => { seen.push(context.timing.deltaMs); }, 'final');

    pipeline.hookUpdate(model, 10);
    pipeline.hookUpdate(model, 10.016);
    pipeline.hookUpdate(model, 30);

    expect(seen[0]).toBe(0);
    expect(seen[1]).toBeCloseTo(16);
    expect(seen[2]).toBe(100);
  });

  it('Cubism 原生 eyeBlink 明确接收秒，不再重复除以 1000', () => {
    const { model, pipeline, updateParameters } = createRuntime();
    pipeline.register(createIdleDisablePlugin(), 'pre');

    pipeline.hookUpdate(model, 5);
    pipeline.hookUpdate(model, 5.02);

    expect(updateParameters).toHaveBeenNthCalledWith(1, model, 0);
    expect(updateParameters.mock.calls[1]?.[1]).toBeCloseTo(0.02);
  });
});

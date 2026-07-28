// 测试 head-pose 插件作为转动输入参数唯一写入方的合成语义:
// idle 摇摆 + 姿态滑块 + speechNod 每帧合成为一个值纯 SET,不依赖帧序假设。
import { describe, expect, it } from 'vitest';
import {
  createHeadPosePlugin,
  NEUTRAL_POSE,
  type Live2DPoseSnapshot,
} from '../composables/head-pose.js';
import type { MotionPluginContext } from '../composables/motion-manager.js';
import type { SpeechAnimationStoreApi } from '../stores/speech-store.js';
import {
  DEFAULT_LIVE2D_RUNTIME_CONFIG,
  type Live2DParameterRuntimeConfig,
} from '../model-config.js';

const PARAMS: Live2DParameterRuntimeConfig = {
  ...DEFAULT_LIVE2D_RUNTIME_CONFIG.parameters,
  speechNodParam: 'ParamAngleY',
  speechNodAmplitude: 3,
};

interface HeadPoseRuntimeOptions {
  pose?: Live2DPoseSnapshot;
  parameters?: Live2DParameterRuntimeConfig;
  idleBeatEnabled?: boolean;
  lipSyncEnabled?: boolean;
  energy?: number;
}

function createRuntime(options: HeadPoseRuntimeOptions = {}) {
  const values = new Map<string, number>();
  const plugin = createHeadPosePlugin({
    readIdleBeatEnabled: () => options.idleBeatEnabled ?? false,
    readPose: () => options.pose ?? NEUTRAL_POSE,
    readParameters: () => options.parameters ?? PARAMS,
    readIdleBeat: () => DEFAULT_LIVE2D_RUNTIME_CONFIG.idleBeat,
    speechStore: {
      getState: () => ({ speaking: true, rms: 0.05, energy: options.energy ?? 0 }),
    } as unknown as SpeechAnimationStoreApi,
    readLipSyncEnabled: () => options.lipSyncEnabled ?? true,
  });
  const ctx = {
    model: {
      getParameterValueById: (id: string) => values.get(id) ?? 0,
      setParameterValueById: (id: string, value: number) => { values.set(id, value); },
    },
    timing: { deltaMs: 1_000 / 60, elapsedMs: 1_000 / 60 },
  } as MotionPluginContext;
  return { values, run: () => plugin(ctx) };
}

describe('head-pose 插件', () => {
  it('姿态滑块直接 SET 到转动输入参数,重复运行幂等', () => {
    const { values, run } = createRuntime({ pose: { ...NEUTRAL_POSE, angleX: 10 } });
    for (let i = 0; i < 30; i += 1) run();
    expect(values.get('ParamAngleX')).toBe(10);
  });

  it('说话点头与滑块合成到同一参数一次写入(Ema 的 Param86 情形)', () => {
    const { values, run } = createRuntime({
      pose: { ...NEUTRAL_POSE, angleY: 4 },
      energy: 0.5,
    });
    run();
    // angleY(4) + nod(0.5 × 3 = 1.5),合并为一次 SET
    expect(values.get('ParamAngleY')).toBeCloseTo(5.5);
  });

  it('静默后点头贡献自动消失,无需簿记', () => {
    const options: HeadPoseRuntimeOptions = {
      pose: { ...NEUTRAL_POSE, angleY: 4 },
      energy: 0.5,
    };
    const { values, run } = createRuntime(options);
    run();
    expect(values.get('ParamAngleY')).toBeCloseTo(5.5);

    options.energy = 0;
    run();
    expect(values.get('ParamAngleY')).toBe(4);
  });

  it('唇同步开关关闭时不再贡献点头', () => {
    const { values, run } = createRuntime({ energy: 0.5, lipSyncEnabled: false });
    run();
    expect(values.get('ParamAngleY')).toBe(0);
  });

  it('合成结果超出 ±30 时按输入参数约定钳制', () => {
    const { values, run } = createRuntime({
      pose: { ...NEUTRAL_POSE, angleY: 29 },
      energy: 1,
    });
    run();
    expect(values.get('ParamAngleY')).toBe(30);
  });

  it('idleBeat 开启时摇摆与滑块叠加;关闭时只剩滑块基准', () => {
    const enabled = createRuntime({
      pose: { ...NEUTRAL_POSE, angleX: 2 },
      idleBeatEnabled: true,
    });
    for (let i = 0; i < 30; i += 1) enabled.run();
    const swayed = enabled.values.get('ParamAngleX')!;
    expect(swayed).not.toBe(2); // 摇摆随时间轴推进,合成值偏离纯滑块值
    expect(enabled.values.has('ParamBreath')).toBe(true);

    const disabled = createRuntime({
      pose: { ...NEUTRAL_POSE, angleX: 2 },
      idleBeatEnabled: false,
    });
    for (let i = 0; i < 30; i += 1) disabled.run();
    expect(disabled.values.get('ParamAngleX')).toBe(2);
    expect(disabled.values.has('ParamBreath')).toBe(false);
  });

  it('未声明 bodyInput 时不写身体参数;声明后按能力写入', () => {
    const pose: Live2DPoseSnapshot = { ...NEUTRAL_POSE, bodyAngleX: 7 };
    const withoutBody = createRuntime({ pose });
    withoutBody.run();
    expect(withoutBody.values.has('ParamBodyAngleX')).toBe(false);

    const withBody = createRuntime({
      pose,
      parameters: {
        ...PARAMS,
        bodyInputX: 'ParamBodyAngleX',
        bodyInputY: 'ParamBodyAngleY',
        bodyInputZ: 'ParamBodyAngleZ',
      },
    });
    withBody.run();
    expect(withBody.values.get('ParamBodyAngleX')).toBe(7);
  });
});

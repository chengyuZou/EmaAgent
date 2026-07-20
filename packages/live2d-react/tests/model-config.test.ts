// 测试 Live2D 外部配置的有限数值、范围、字符串归一化与重载边界。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE2D_RUNTIME_CONFIG,
  live2DReloadConfigKey,
  resolveLive2DModelRuntimeConfig,
} from '../src/model-config.js';

describe('Live2D runtime config', () => {
  it('拒绝 NaN、空参数名和过短随机动作间隔', () => {
    const resolved = resolveLive2DModelRuntimeConfig({
      modelId: '  ',
      parameters: {
        mouthOpenParam: ' ',
        mouthOpenMax: Number.NaN,
        speechNodAmplitude: -4,
      },
      idleBeat: {
        swayAmplitude: Number.POSITIVE_INFINITY,
        breathFrequency: -1,
      },
      randomIdle: {
        group: '',
        minDelayMs: -10,
        maxDelayMs: 500,
      },
    });

    expect(resolved.modelId).toBe('unknown');
    expect(resolved.parameters.mouthOpenParam).toBe('ParamMouthOpenY');
    expect(resolved.parameters.mouthOpenMax).toBe(DEFAULT_LIVE2D_RUNTIME_CONFIG.parameters.mouthOpenMax);
    expect(resolved.parameters.speechNodAmplitude).toBe(0);
    expect(resolved.idleBeat.swayAmplitude).toBe(DEFAULT_LIVE2D_RUNTIME_CONFIG.idleBeat.swayAmplitude);
    expect(resolved.idleBeat.breathFrequency).toBe(0);
    expect(resolved.randomIdle).toEqual({ group: 'Idle', minDelayMs: 1_000, maxDelayMs: 1_000 });
  });

  it('只有 modelId 改变需要重建模型运行实例', () => {
    const base = live2DReloadConfigKey({ modelId: 'ema' });
    expect(live2DReloadConfigKey({ modelId: 'ema', idleBeat: { swayAmplitude: 20 } })).toBe(base);
    expect(live2DReloadConfigKey({ modelId: 'ema-2' })).not.toBe(base);
  });
});

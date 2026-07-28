// 测试 audio-lipsync 口型驱动:说话时 RMS 增益驱动 mouthOpen,
// 静默或唇同步禁用后平滑释放到 0。
import { describe, expect, it } from 'vitest';
import { createAudioLipSyncPlugin } from '../composables/audio-lipsync.js';
import type { MotionPluginContext } from '../composables/motion-manager.js';
import type { SpeechAnimationStoreApi } from '../stores/speech-store.js';
import {
  DEFAULT_LIVE2D_RUNTIME_CONFIG,
  type Live2DParameterRuntimeConfig,
} from '../model-config.js';

const PARAMS: Live2DParameterRuntimeConfig = DEFAULT_LIVE2D_RUNTIME_CONFIG.parameters;

interface SpeechState { speaking: boolean; rms: number; energy: number }

function createRuntime(speech: SpeechState, enabled: () => boolean = () => true) {
  const values = new Map<string, number>();
  const plugin = createAudioLipSyncPlugin(
    { getState: () => speech } as unknown as SpeechAnimationStoreApi,
    () => PARAMS,
    enabled,
  );
  const ctx = {
    model: {
      getParameterValueById: (id: string) => values.get(id) ?? 0,
      setParameterValueById: (id: string, value: number) => { values.set(id, value); },
    },
    timing: { deltaMs: 1_000 / 60, elapsedMs: 1_000 / 60 },
  } as MotionPluginContext;
  return { values, run: () => plugin(ctx) };
}

describe('audio-lipsync 口型', () => {
  it('说话时驱动口型,静默后释放到 0', () => {
    const speech: SpeechState = { speaking: true, rms: 0.5, energy: 0.5 };
    const { values, run } = createRuntime(speech);
    for (let i = 0; i < 30; i += 1) run();
    expect(values.get('ParamMouthOpenY')).toBeGreaterThan(0.5);

    speech.speaking = false;
    speech.rms = 0;
    for (let i = 0; i < 120; i += 1) run();
    expect(values.get('ParamMouthOpenY')).toBeCloseTo(0, 1);
  });

  it('禁用唇同步时口型释放到 0', () => {
    let enabled = true;
    const speech: SpeechState = { speaking: true, rms: 0.5, energy: 0.5 };
    const { values, run } = createRuntime(speech, () => enabled);
    for (let i = 0; i < 30; i += 1) run();
    expect(values.get('ParamMouthOpenY')).toBeGreaterThan(0);

    enabled = false;
    for (let i = 0; i < 120; i += 1) run();
    expect(values.get('ParamMouthOpenY')).toBeCloseTo(0, 1);
  });
});

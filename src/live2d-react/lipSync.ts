import type { CubismInternalModel } from '@laplace.live/pixijs-live2d';
import type { ResolvedLive2DLipSyncParameter } from './modelBindings.js';

const BASE_FRAME_MS = 1_000 / 60;
const MAX_FRAME_DELTA_MS = 100;
const ATTACK_AT_60_FPS = 0.35;
const RELEASE_AT_60_FPS = 0.12;
const HOLD_AFTER_SPEECH_MS = 700;

type LipSyncPhase = 'speaking' | 'hold' | 'handoff';

export interface Live2DLipSync {
  set(speaking: boolean, mouthOpen: number): void;
  dispose(): void;
}

export function attachLive2DLipSync(
  internalModel: CubismInternalModel,
  parameters: readonly ResolvedLive2DLipSyncParameter[],
): Live2DLipSync {
  let phase: LipSyncPhase = 'handoff';
  let mouthOpen = 0;
  let current = 0;
  let holdRemainingMs = 0;
  let lastFrameAt: number | null = null;

  const update = (): void => {
    const now = performance.now();
    const deltaMs = lastFrameAt === null
      ? BASE_FRAME_MS
      : Math.min(MAX_FRAME_DELTA_MS, Math.max(0, now - lastFrameAt));
    lastFrameAt = now;

    if (phase === 'handoff') return;

    if (phase === 'hold') {
      // 说完后先平滑闭嘴并维持 700ms, 避免动作曲线立刻把嘴重新顶开.
      holdRemainingMs -= deltaMs;
      if (holdRemainingMs <= 0) {
        // 此后不写嘴参数, 让模型自身的 Motion 和 Expression 决定口型.
        phase = 'handoff';
        current = 0;
        return;
      }
    }

    const target = phase === 'speaking' ? mouthOpen : 0;
    const factor = frameRateIndependentFactor(
      target > current ? ATTACK_AT_60_FPS : RELEASE_AT_60_FPS,
      deltaMs,
    );
    current += (target - current) * factor;

    for (const parameter of parameters) {
      const value = parameter.closedValue
        + (parameter.openValue - parameter.closedValue) * current;
      internalModel.coreModel.setParameterValueByIndex(parameter.index, value);
    }
  };

  internalModel.on('beforeModelUpdate', update);

  return {
    set(nextSpeaking, nextMouthOpen) {
      if (nextSpeaking) {
        phase = 'speaking';
        mouthOpen = Number.isFinite(nextMouthOpen)
          ? Math.min(1, Math.max(0, nextMouthOpen))
          : 0;
      } else if (phase === 'speaking') {
        phase = 'hold';
        holdRemainingMs = HOLD_AFTER_SPEECH_MS;
      }
    },
    dispose() {
      internalModel.off('beforeModelUpdate', update);
    },
  };
}

function frameRateIndependentFactor(factorAt60Fps: number, deltaMs: number): number {
  return 1 - Math.pow(1 - factorAt60Fps, deltaMs / BASE_FRAME_MS);
}

// 在 Cubism 完成 Motion、Expression、Physics 后的唯一帧写入点平滑驱动口型。
//
// 说话才占有嘴参数：宿主停止说话后进入约 700ms 的 hold（先平滑闭嘴、再按住，
// 防止 Motion 曲线的非零残值立刻把嘴顶开），hold 耗尽后彻底停笔。Cubism 每帧会
// 把参数回滚到 Motion 快照，停笔即交还，带嘴曲线的 Motion/Expression 此后正常生效。

import type { Cubism4InternalModel } from 'pixi-live2d-display/cubism4';
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
  internalModel: Cubism4InternalModel,
  readParameters: () => readonly ResolvedLive2DLipSyncParameter[],
): Live2DLipSync {
  // 0.5.0-beta 运行时继承 EventEmitter，但打包后的 d.ts 丢失了 on/off 成员。
  const frameEvents = internalModel as Cubism4InternalModel & {
    on(event: 'beforeModelUpdate', listener: () => void): void;
    off(event: 'beforeModelUpdate', listener: () => void): void;
  };
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
      holdRemainingMs -= deltaMs;
      if (holdRemainingMs <= 0) {
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

    for (const parameter of readParameters()) {
      const value = parameter.closedValue
        + (parameter.openValue - parameter.closedValue) * current;
      internalModel.coreModel.setParameterValueByIndex(parameter.index, value);
    }
  };

  frameEvents.on('beforeModelUpdate', update);

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
      frameEvents.off('beforeModelUpdate', update);
    },
  };
}

function frameRateIndependentFactor(factorAt60Fps: number, deltaMs: number): number {
  return 1 - Math.pow(1 - factorAt60Fps, deltaMs / BASE_FRAME_MS);
}

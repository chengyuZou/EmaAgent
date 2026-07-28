// 根据指定舞台的语音能量驱动 Live2D 口型。
// ── AudioLipSyncPlugin ───────────────────────────────────────────────────────
//
// Final-stage pipeline plugin. Reads real-time audio RMS from SpeechAnimationStore
// and drives the Live2D mouth-open parameter.
//
// When speaking:  ParamMouthOpenY = rms * 2.1  (range from ema.vtube.json)
// When silent or lip-sync disabled: smoothly releases mouth toward 0 over ~200ms
//
// 说话点头(speechNod)不在本插件:它与 idle 摇摆、姿态滑块共享转动输入参数,
// 由 head-pose 插件作为唯一写入方统一合成,避免多写入方加算链的累积问题。

import type { MotionPlugin } from './motion-manager.js';
import type { SpeechAnimationStoreApi } from '../stores/speech-store.js';
import type { Live2DParameterRuntimeConfig } from '../model-config.js';
import { frameRateIndependentFactor } from './frame-timing.js';

/** Per-frame release speed when not speaking (exponential decay). */
const RELEASE_AT_60_FPS = 0.12;
const ATTACK_AT_60_FPS = 0.35;

/**
 * RMS→mouth gain. Speech RMS off a normalized waveform sits around 0.02–0.08
 * (measured: peaks ~0.07). mouthOpenMax (2.1) is the param's FULL-OPEN value
 * expecting a 0–1 "openness" input — so feeding raw RMS opened the mouth to at
 * most 0.07×2.1 ≈ 0.15 (invisible). This gain lifts typical speech into the
 * 0–1 range before scaling; clamped so loud frames don't over-drive.
 */
const RMS_GAIN = 13;

export function createAudioLipSyncPlugin(
  speechStore: SpeechAnimationStoreApi,
  readParameters: () => Live2DParameterRuntimeConfig,
  readEnabled: () => boolean = () => true,
): MotionPlugin {
  let currentMouth = 0;

  return (ctx) => {
    const { speaking, rms } = speechStore.getState();
    const params = readParameters();
    const attack = frameRateIndependentFactor(ATTACK_AT_60_FPS, ctx.timing.deltaMs);
    const release = frameRateIndependentFactor(RELEASE_AT_60_FPS, ctx.timing.deltaMs);

    if (readEnabled() && speaking && rms > 0.01) {
      const openness = Math.min(1, rms * RMS_GAIN);
      currentMouth += (openness * params.mouthOpenMax - currentMouth) * attack;
    } else {
      currentMouth += (0 - currentMouth) * release;
    }

    ctx.model.setParameterValueById(params.mouthOpenParam, currentMouth);
  };
}

// 根据指定舞台的语音能量驱动 Live2D 口型与轻微身体律动。
// ── AudioLipSyncPlugin ───────────────────────────────────────────────────────
//
// Final-stage pipeline plugin. Reads real-time audio RMS from SpeechAnimationStore
// and drives the Live2D mouth-open parameter.
//
// When speaking:  ParamMouthOpenY = rms * 2.1  (range from ema.vtube.json)
// When silent:    smoothly releases mouth toward 0 over ~200ms
//
// Also applies a subtle additive head nod on Param86 from the smoothed energy,
// so the character "bounces" slightly with speech emphasis.

import type { MotionPlugin } from './motion-manager.js';
import type { SpeechAnimationStoreApi } from '../stores/speech-store.js';
import type { Live2DParameterRuntimeConfig } from '../model-config.js';

/** Per-frame release speed when not speaking (exponential decay). */
const RELEASE = 0.12;

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
): MotionPlugin {
  let currentMouth = 0;

  return (ctx) => {
    const { speaking, rms, energy } = speechStore.getState();
    const params = readParameters();

    if (speaking && rms > 0.01) {
      const openness = Math.min(1, rms * RMS_GAIN);
      currentMouth += (openness * params.mouthOpenMax - currentMouth) * 0.35;
    } else {
      currentMouth += (0 - currentMouth) * RELEASE;
    }

    ctx.model.setParameterValueById(params.mouthOpenParam, currentMouth);

    // Subtle speech-emphasis head nod — additive on top of idle-beat
    if (params.speechNodParam && energy > 0.02) {
      const nod = energy * params.speechNodAmplitude;
      const current = ctx.model.getParameterValueById(params.speechNodParam);
      ctx.model.setParameterValueById(params.speechNodParam, current + nod);
    }
  };
}

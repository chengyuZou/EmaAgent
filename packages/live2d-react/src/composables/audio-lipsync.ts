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
import { useSpeechStore } from '../stores/speech-store.js';
import type { Live2DParameterRuntimeConfig } from '../model-config.js';

/** Per-frame release speed when not speaking (exponential decay). */
const RELEASE = 0.12;

export function createAudioLipSyncPlugin(
  readParameters: () => Live2DParameterRuntimeConfig,
): MotionPlugin {
  let currentMouth = 0;

  return (ctx) => {
    const { speaking, rms, energy } = useSpeechStore.getState();
    const params = readParameters();

    if (speaking && rms > 0.01) {
      currentMouth += (rms * params.mouthOpenMax - currentMouth) * 0.35;
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

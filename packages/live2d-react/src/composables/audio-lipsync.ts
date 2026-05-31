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

/** Matches ema.vtube.json: MouthOpen output range upper bound. */
const MOUTH_MAX = 2.1;
/** Max additive degrees for speech-emphasis head nod. */
const NOD_AMPLITUDE = 3.0;
/** Per-frame release speed when not speaking (exponential decay). */
const RELEASE = 0.12;

export function createAudioLipSyncPlugin(): MotionPlugin {
  let currentMouth = 0;

  return (ctx) => {
    const { speaking, rms, energy } = useSpeechStore.getState();

    if (speaking && rms > 0.01) {
      currentMouth += (rms * MOUTH_MAX - currentMouth) * 0.35;
    } else {
      currentMouth += (0 - currentMouth) * RELEASE;
    }

    ctx.model.setParameterValueById('ParamMouthOpenY', currentMouth);

    // Subtle speech-emphasis head nod — additive on top of idle-beat
    if (energy > 0.02) {
      const nod = energy * NOD_AMPLITUDE;
      const current = ctx.model.getParameterValueById('Param86');
      ctx.model.setParameterValueById('Param86', current + nod);
    }
  };
}

// ── RandomIdleMotionScheduler ─────────────────────────────────────────────────
//
// When the model is loaded and the character is not speaking, plays a random
// Idle-group motion every 12–35 seconds.
//
// Not a pipeline plugin — runs on a setInterval outside the per-frame loop.
// Initialised from Live2DStage after the model is ready.

import { useSpeechStore } from '../stores/speech-store.js';

/**
 * Start the idle-motion scheduler. Returns a cleanup function.
 *
 * @param playMotion  Callback that triggers a motion group + optional index.
 *                    Typically `model.motion(group, index)` from pixi-live2d-display.
 * @param motionCount Number of motions in the Idle group (used for random index).
 */
export function startRandomIdleScheduler(
  playMotion: (group: string, index?: number) => void,
  motionCount: number,
): () => void {
  if (motionCount === 0) return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(): void {
    const ms = 12_000 + Math.random() * 23_000; // 12–35 seconds
    timer = setTimeout(() => {
      if (!useSpeechStore.getState().speaking) {
        const idx = Math.floor(Math.random() * motionCount);
        playMotion('Idle', idx);
      }
      schedule(); // next
    }, ms);
  }

  schedule();

  return () => {
    if (timer !== null) clearTimeout(timer);
  };
}

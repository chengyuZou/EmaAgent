// ── Idle eye focus ──────────────────────────────────────────────────────────
//
// Simulates idle "looking around" by:
//   - Picking random focus targets every 800-3500ms (saccade)
//   - Moving the head/focusController toward that target
//   - Lerping ParamEyeBallX / ParamEyeBallY toward target each frame
//
// Pure factory (no React) so callers can integrate from anywhere.
// Ported from AIRI's useLive2DIdleEyeFocus.

import { randFloat, randomSaccadeInterval, lerp } from '../utils/math.js';

export interface IdleEyeFocusController {
  /** Call every frame with the PIXI internal model + monotonic time (seconds). */
  update(model: InternalModelLike, now: number): void;
}

/**
 * Minimal type surface we need from the pixi-live2d-display InternalModel.
 * Keeping it loose so this file doesn't depend on the runtime library types
 * at compile time.
 */
export interface InternalModelLike {
  focusController: {
    focus(x: number, y: number, instant?: boolean): void;
    update(deltaSec: number): void;
  };
  coreModel: {
    getParameterValueById(id: string): number;
    setParameterValueById(id: string, value: number): void;
  };
}

/**
 * Create a stateful idle-focus controller. Times are tracked in seconds
 * (caller passes `now` in seconds — matches PIXI ticker convention).
 *
 * Use when:
 * - The model is in an idle motion (otherwise motion drives the eyes)
 *
 * Expects:
 * - `now` is monotonic seconds since some epoch
 * - Caller computes deltaSec internally; we use lastSaccadeAt
 *
 * Returns:
 * - { update(model, now) } — call every frame
 */
export function createIdleEyeFocus(): IdleEyeFocusController {
  let nextSaccadeAfter = -1;
  let focusTarget: [number, number] = [0, 0];
  let lastSaccadeAt = -1;

  return {
    update(model, now) {
      if (now >= nextSaccadeAfter || now < lastSaccadeAt) {
        // Pick a new target — biased slightly upward (y range 0.7 instead of 1)
        // because looking down looks awkward on most Cubism models.
        focusTarget    = [randFloat(-1, 1), randFloat(-1, 0.7)];
        lastSaccadeAt  = now;
        nextSaccadeAfter = now + randomSaccadeInterval() / 1000;
        model.focusController.focus(focusTarget[0] * 0.5, focusTarget[1] * 0.5, false);
      }

      model.focusController.update(now - lastSaccadeAt);

      const core = model.coreModel;
      const currentX = core.getParameterValueById('ParamEyeBallX');
      const currentY = core.getParameterValueById('ParamEyeBallY');
      core.setParameterValueById('ParamEyeBallX', lerp(currentX, focusTarget[0], 0.3));
      core.setParameterValueById('ParamEyeBallY', lerp(currentY, focusTarget[1], 0.3));
    },
  };
}

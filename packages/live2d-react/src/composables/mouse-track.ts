// ── Mouse eye tracking plugin ───────────────────────────────────────────────
//
// Pre-stage pipeline plugin. Uses window-level mousemove (not canvas-level)
// because Tauri's drag region div sits above the canvas and blocks all
// pointer events — the canvas never receives them directly.
//
// Eyes smoothly track cursor position relative to canvas center.
// When cursor leaves canvas bounds, eyes glide back to center.

import type { MotionPlugin } from './motion-manager.js';

// ── Tuning ───────────────────────────────────────────────────────────────────

const EYE_RANGE_X = 0.35;
const EYE_RANGE_Y = 0.3;
const SMOOTH      = 0.08;

// ── Factory ──────────────────────────────────────────────────────────────────

export function createMouseEyeTrackPlugin(
  getCanvas: () => HTMLCanvasElement | null,
): MotionPlugin {
  let targetX = 0;
  let targetY = 0;
  let mouseInBounds = false;

  let bound = false;

  function bind(): void {
    if (bound) return;
    bound = true;

    window.addEventListener('mousemove', (e: MouseEvent) => {
      const canvas = getCanvas();
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      mouseInBounds =
        e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top  && e.clientY <= rect.bottom;

      if (mouseInBounds) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top  + rect.height / 2;
        targetX = ((e.clientX - cx) / (rect.width  / 2)) * EYE_RANGE_X;
        targetY = ((e.clientY - cy) / (rect.height / 2)) * EYE_RANGE_Y;
      } else {
        targetX = 0;
        targetY = 0;
      }
    });
  }

  let currentX = 0;
  let currentY = 0;

  return (ctx) => {
    bind();

    if (mouseInBounds) {
      currentX += (targetX - currentX) * SMOOTH;
      currentY += (targetY - currentY) * SMOOTH;
    } else {
      currentX += (0 - currentX) * SMOOTH;
      currentY += (0 - currentY) * SMOOTH;
    }

    ctx.model.setParameterValueById('ParamEyeBallX', currentX);
    ctx.model.setParameterValueById('ParamEyeBallY', currentY);
  };
}

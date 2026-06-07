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

export interface DisposableMotionPlugin extends MotionPlugin {
  dispose(): void;
}

export function createMouseEyeTrackPlugin(
  getCanvas: () => HTMLCanvasElement | null,
  readEnabled: () => boolean = () => true,
): DisposableMotionPlugin {
  let targetX = 0;
  let targetY = 0;
  let mouseInBounds = false;

  let bound = false;
  let onMouseMove: ((e: MouseEvent) => void) | null = null;

  function bind(): void {
    if (bound) return;
    bound = true;

    onMouseMove = (e: MouseEvent) => {
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
    };

    window.addEventListener('mousemove', onMouseMove);
  }

  function dispose(): void {
    if (onMouseMove) window.removeEventListener('mousemove', onMouseMove);
    onMouseMove = null;
    bound = false;
  }

  let currentX = 0;
  let currentY = 0;

  // Bind once at creation time — no need to call every frame.
  bind();

  const plugin = ((ctx) => {
    if (!readEnabled()) {
      targetX = 0;
      targetY = 0;
      mouseInBounds = false;
    }

    if (mouseInBounds) {
      currentX += (targetX - currentX) * SMOOTH;
      currentY += (targetY - currentY) * SMOOTH;
    } else {
      currentX += (0 - currentX) * SMOOTH;
      currentY += (0 - currentY) * SMOOTH;
    }

    ctx.model.setParameterValueById('ParamEyeBallX', currentX);
    ctx.model.setParameterValueById('ParamEyeBallY', currentY);
  }) as DisposableMotionPlugin;

  plugin.dispose = dispose;
  return plugin;
}

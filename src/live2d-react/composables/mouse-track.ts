// 根据鼠标相对舞台的位置，以跨帧率一致的速度驱动 Live2D 视线参数。
//
// Pre-stage pipeline plugin. Uses window-level mousemove (not canvas-level)
// because Tauri's drag region div sits above the canvas and blocks all
// pointer events — the canvas never receives them directly.
//
// Eyes smoothly track cursor position relative to canvas center.
// When cursor leaves canvas bounds, eyes glide back to center.

import type { DisposableMotionPlugin, MotionPlugin } from './motion-manager.js';
import { frameRateIndependentFactor } from './frame-timing.js';

export type { DisposableMotionPlugin } from './motion-manager.js';

// ── Tuning ───────────────────────────────────────────────────────────────────

const EYE_RANGE_X = 0.35;
const EYE_RANGE_Y = 0.3;
const SMOOTH_AT_60_FPS = 0.08;

// ── Factory ──────────────────────────────────────────────────────────────────

export function createMouseEyeTrackPlugin(
  getCanvas: () => HTMLCanvasElement | null,
  readEnabled: () => boolean = () => true,
): DisposableMotionPlugin {
  let targetX = 0;
  let targetY = 0;
  let mouseInBounds = false;

  let bound = false;
  let onMouseMove: ((e: MouseEvent) => void) | null = null;
  let onGeometryChange: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let canvasBounds: DOMRect | null = null;

  function refreshCanvasBounds(): void {
    canvasBounds = getCanvas()?.getBoundingClientRect() ?? null;
  }

  function bind(): void {
    if (bound) return;
    bound = true;
    refreshCanvasBounds();

    onMouseMove = (e: MouseEvent) => {
      const rect = canvasBounds;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
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
    onGeometryChange = refreshCanvasBounds;
    window.addEventListener('resize', onGeometryChange);
    window.addEventListener('scroll', onGeometryChange, true);

    const canvas = getCanvas();
    if (canvas && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(refreshCanvasBounds);
      resizeObserver.observe(canvas);
    }
  }

  function dispose(): void {
    if (onMouseMove) window.removeEventListener('mousemove', onMouseMove);
    if (onGeometryChange) {
      window.removeEventListener('resize', onGeometryChange);
      window.removeEventListener('scroll', onGeometryChange, true);
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    canvasBounds = null;
    onMouseMove = null;
    onGeometryChange = null;
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

    const smoothing = frameRateIndependentFactor(SMOOTH_AT_60_FPS, ctx.timing.deltaMs);
    const destinationX = mouseInBounds ? targetX : 0;
    const destinationY = mouseInBounds ? targetY : 0;
    currentX += (destinationX - currentX) * smoothing;
    currentY += (destinationY - currentY) * smoothing;

    ctx.model.setParameterValueById(ctx.paramNames.eyeBallXParam, currentX);
    ctx.model.setParameterValueById(ctx.paramNames.eyeBallYParam, currentY);
  }) as DisposableMotionPlugin;

  plugin.dispose = dispose;
  return plugin;
}

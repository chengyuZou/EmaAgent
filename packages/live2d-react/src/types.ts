// ── Public types ────────────────────────────────────────────────────────────

/**
 * How the model should be framed inside the stage.
 *
 *   - 'halfbody':  Head + torso (default for desktop pet). Fit width × 1.55,
 *                  head touches top edge, legs flow off-screen.
 *   - 'fullbody':  Whole model fits. Used for character preview / settings.
 */
export type Live2DFraming = 'halfbody' | 'fullbody';

/**
 * Errors surfaced via the stage's `onError` callback. The kind is coarse so
 * the consumer can decide between "model file broken" vs "Cubism Core missing"
 * without parsing strings.
 */
export type Live2DErrorKind =
  | 'cubism_core_missing'   // window.Live2DCubismCore not present at load time
  | 'model_load_failed'     // model3.json fetch / parse / texture decode failed
  | 'pixi_init_failed'      // PIXI Application could not be created (no WebGL?)
  | 'unknown';

export interface Live2DError {
  kind:    Live2DErrorKind;
  message: string;
  cause?:  unknown;
}

/**
 * Imperative handle for callers that don't want to drive the model through the
 * Zustand store. Most consumers should use the store; this handle exists for
 * tests + ad-hoc scripts.
 *
 * For multi-expression control, prefer the store directly:
 *   useLive2DStore.getState().addExpression("Smile")
 *   useLive2DStore.getState().toggleExpression("Blush")
 *   useLive2DStore.getState().clearExpressions()
 */
export interface Live2DStageHandle {
  /** Replace all active expressions with a single one (or null = clear). */
  setExpression(name: string | null): void;
  playMotion(group: string, index?: number): Promise<void>;
  isReady(): boolean;
}

// ── Plugin pipeline types (used by Live2DModel internally) ──────────────────

/**
 * MotionManager update pipeline plugin. Plugins run in three stages — pre /
 * post / final. See AIRI's design for rationale:
 *   - pre   : may short-circuit the original update (handled=true to skip)
 *   - post  : runs after original update; can also short-circuit follow-ons
 *   - final : ALWAYS runs (expression / auto-blink); ignores `handled` flag
 *
 * V1 ships no plugins by default. V1.5 will add beat-sync, auto-blink,
 * eye-tracking. The pipeline is implemented in src/composables/useMotionManager.ts
 * even though we don't ship plugins yet — adding them later doesn't change the
 * pipeline shape.
 */
export interface MotionUpdatePlugin {
  name:  string;
  stage: 'pre' | 'post' | 'final';
  run(ctx: MotionUpdateContext): { handled: boolean };
}

export interface MotionUpdateContext {
  model:      unknown;       // pixi-live2d-display Live2DModel instance
  now:        number;
  deltaMs:    number;
  /** Set true to signal subsequent same-stage plugins to skip. */
  handled:    boolean;
}

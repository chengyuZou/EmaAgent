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
  /**
   * Fire-and-forget motion command. It means "request this motion now", not
   * "wait until the motion has completed".
   */
  playMotion(group: string, index?: number): void;
  isReady(): boolean;
}

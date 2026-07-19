// 编排 Live2D 原生 motion update 与前置、后置、最终参数插件。
import { clamp01 } from '../utils/math.js';
import type { ExpressionController } from './expression-controller.js';
import { FrameClock, type FrameTiming } from './frame-timing.js';

// ── Live2D motion-manager update pipeline ───────────────────────────────────
//
// Hooks pixi-live2d-display's motionManager.update so we can run plugins
// before / after / final-stage relative to the library's own update.
//
// Stages:
//   - pre   : may short-circuit (set handled=true to skip the original update)
//   - post  : runs after original update; may also short-circuit follow-ons
//   - final : ALWAYS runs (e.g. expression / auto-blink overlays). Ignores
//             the `handled` flag.
//
// Ported from AIRI's motion-manager.ts. Vue refs → plain closures.

// ── Types ───────────────────────────────────────────────────────────────────

/** Subset of pixi-live2d-display's CubismModel ("coreModel"). */
export interface CubismCoreLike {
  getParameterValueById(id: string): number;
  setParameterValueById(id: string, value: number): void;
}

/** Subset of pixi-live2d-display's InternalModel needed by plugins. */
export interface InternalModelForPlugins {
  coreModel: CubismCoreLike;
  motionManager: {
    state:    { currentGroup: string | undefined };
    groups:   { idle?: string };
    stopAllMotions(): void;
    update(model: CubismCoreLike, now: number): boolean;
  };
  eyeBlink?: {
    updateParameters(model: CubismCoreLike, deltaSec: number): void;
  };
}

/** Per-frame plugin context. Each stage's plugins receive this. */
export interface MotionPluginContext {
  model:          CubismCoreLike;
  /** 统一为毫秒的插件时间；长卡顿单帧最多推进 100ms。 */
  timing:         FrameTiming;
  internalModel:  InternalModelForPlugins;
  motionManager:  InternalModelForPlugins['motionManager'];

  /**
   * Live2D model parameter overrides (eye open base, etc.). Read by the
   * auto-blink plugin to clamp final output. Provided by caller's store.
   */
  modelParameters: ModelParametersSnapshot;
  /** User-facing toggle: idle animations enabled. */
  idleAnimationEnabled: boolean;
  /** User-facing toggle: auto-eye-blink enabled. */
  autoBlinkEnabled:     boolean;
  /** Force blink state machine even when model has its own eyeBlink curves. */
  forceAutoBlinkEnabled: boolean;
  /** Whether the currently-playing motion is the idle one. */
  isIdleMotion:    boolean;
  /** Set true to short-circuit subsequent same-stage plugins + original update. */
  handled:         boolean;
  markHandled():   void;
}

export type MotionPlugin = (ctx: MotionPluginContext) => void;

/** Snapshot of the user-configurable per-frame parameter overrides. */
export interface ModelParametersSnapshot {
  leftEyeOpen:  number;
  rightEyeOpen: number;
  // Additional per-parameter overrides can be added here as we expose them.
}

export interface MotionManagerUpdateOptions {
  internalModel: InternalModelForPlugins;
  /** Reader for runtime parameter state — called every frame. */
  readModelParameters(): ModelParametersSnapshot;
  readFlags(): {
    idleAnimationEnabled:   boolean;
    autoBlinkEnabled:       boolean;
    forceAutoBlinkEnabled:  boolean;
  };
}

export interface MotionManagerUpdate {
  register(plugin: MotionPlugin, stage: 'pre' | 'post' | 'final'): () => void;
  /**
   * Hooked replacement for `motionManager.update(model, now)`. Returns
   * whether the original update was "handled" (matches Cubism's bool result).
   */
  hookUpdate(
    model:        CubismCoreLike,
    now:          number,
    originalUpdate?: (model: CubismCoreLike, now: number) => boolean,
  ): boolean;
}

/**
 * Create a stateful pipeline. Plugins are registered with `register()` and
 * fire in the order they were added within their stage.
 */
export function createMotionManagerUpdate(
  options: MotionManagerUpdateOptions,
): MotionManagerUpdate {
  const prePlugins:   MotionPlugin[] = [];
  const postPlugins:  MotionPlugin[] = [];
  const finalPlugins: MotionPlugin[] = [];

  const frameClock = new FrameClock();

  function register(plugin: MotionPlugin, stage: 'pre' | 'post' | 'final'): () => void {
    const bucket = stage === 'pre' ? prePlugins : stage === 'post' ? postPlugins : finalPlugins;
    bucket.push(plugin);
    return () => {
      const i = bucket.indexOf(plugin);
      if (i >= 0) bucket.splice(i, 1);
    };
  }

  function runPlugins(plugins: MotionPlugin[], ctx: MotionPluginContext, ignoreHandled: boolean): void {
    for (const plugin of plugins) {
      if (!ignoreHandled && ctx.handled) break;
      plugin(ctx);
    }
  }

  function hookUpdate(
    model:          CubismCoreLike,
    now:            number,
    originalUpdate?: (model: CubismCoreLike, now: number) => boolean,
  ): boolean {
    // pixi-live2d-display Cubism 4 在调用 motionManager.update 前已把 now
    // 从 performance.now() 毫秒转换为秒。这里只在唯一入口转换一次。
    const timing = frameClock.advance(now);
    const mm = options.internalModel.motionManager;
    const idleGroupName = mm.groups.idle;
    const isIdleMotion = !mm.state.currentGroup
      || mm.state.currentGroup === idleGroupName;

    const flags = options.readFlags();
    const ctx: MotionPluginContext = {
      model,
      timing,
      internalModel:  options.internalModel,
      motionManager:  mm,
      modelParameters: options.readModelParameters(),
      idleAnimationEnabled:    flags.idleAnimationEnabled,
      autoBlinkEnabled:        flags.autoBlinkEnabled,
      forceAutoBlinkEnabled:   flags.forceAutoBlinkEnabled,
      isIdleMotion,
      handled: false,
      markHandled() { this.handled = true; },
    };

    runPlugins(prePlugins, ctx, false);

    if (!ctx.handled && originalUpdate) {
      const result = originalUpdate.call(mm, model, now);
      if (result) ctx.handled = true;
    }

    runPlugins(postPlugins, ctx, false);

    // Final stage always runs — expression overlay must apply regardless
    runPlugins(finalPlugins, ctx, true);

    return ctx.handled;
  }

  return { register, hookUpdate };
}

// ── Built-in plugins ────────────────────────────────────────────────────────
//
// Each is a factory returning a MotionPlugin closure. Order to register
// (matches AIRI):
//
//   pre:   optional short-circuit plugins
//   post:  (none by default)
//   final: autoEyeBlink, expression
//
// Beat sync is intentionally NOT ported — no music input source in V1.

/**
 * If idle animations are disabled, stop motions during idle and apply manual
 * eye parameter overrides instead. Used to "freeze" Ema in a specific pose.
 */
export function createIdleDisablePlugin(): MotionPlugin {
  return (ctx) => {
    if (ctx.handled) return;
    if (!ctx.idleAnimationEnabled && ctx.isIdleMotion) {
      ctx.motionManager.stopAllMotions();
      if (ctx.internalModel.eyeBlink) {
        ctx.internalModel.eyeBlink.updateParameters(ctx.model, ctx.timing.deltaMs / 1000);
      }
      ctx.model.setParameterValueById('ParamEyeLOpen', ctx.modelParameters.leftEyeOpen);
      ctx.model.setParameterValueById('ParamEyeROpen', ctx.modelParameters.rightEyeOpen);
      ctx.markHandled();
    }
  };
}

/**
 * Auto-eye-blink state machine. Replicates AIRI's behavior exactly:
 *   - 75ms close (ease-out), 75ms open (ease-in), random 3-8s gap
 *   - Threshold: skip blink if eyes already closed by expression
 *   - "Force" mode for models without baked-in blink curves
 *
 * @param liveExpressionEnabled - When false, runs AIRI's "expression OFF"
 *                                 path (absolute writes + markHandled). When
 *                                 true, runs the multiply-modulate path so
 *                                 expression plugin can overlay afterwards.
 */
export function createAutoEyeBlinkPlugin(opts: {
  readExpressionEnabled(): boolean;
}): MotionPlugin {
  // Per-plugin-instance state
  const blinkCloseDuration = 75; // ms
  const blinkOpenDuration  = 75;
  const minDelayMs = 3000;
  const maxDelayMs = 8000;

  const state = {
    phase:      'idle' as 'idle' | 'closing' | 'opening',
    progress:   0,
    startLeft:  1,
    startRight: 1,
    delayMs:    randomDelay(),
  };
  let preBlinkLeft  = 1;
  let preBlinkRight = 1;

  function randomDelay(): number {
    return minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
  }
  function resetBlink(): void {
    state.phase = 'idle';
    state.progress = 0;
    state.delayMs = randomDelay();
  }
  function easeOutQuad(t: number): number { return 1 - (1 - t) * (1 - t); }
  function easeInQuad(t: number):  number { return t * t; }

  /** Run the close/open state machine. Returns target eye-open factors. */
  function advanceForced(dtMs: number, baseLeft: number, baseRight: number): { eyeL: number; eyeR: number } {
    if (state.phase === 'idle') {
      state.delayMs = Math.max(0, state.delayMs - dtMs);
      if (state.delayMs === 0) {
        state.phase      = 'closing';
        state.progress   = 0;
        state.startLeft  = baseLeft;
        state.startRight = baseRight;
      }
      return { eyeL: baseLeft, eyeR: baseRight };
    }
    if (state.phase === 'closing') {
      state.progress = Math.min(1, state.progress + dtMs / blinkCloseDuration);
      const eased = easeOutQuad(state.progress);
      const eyeL = clamp01(state.startLeft  * (1 - eased));
      const eyeR = clamp01(state.startRight * (1 - eased));
      if (state.progress >= 1) {
        state.phase    = 'opening';
        state.progress = 0;
      }
      return { eyeL, eyeR };
    }
    // 'opening'
    state.progress = Math.min(1, state.progress + dtMs / blinkOpenDuration);
    const eased = easeInQuad(state.progress);
    const eyeL = clamp01(state.startLeft  * eased);
    const eyeR = clamp01(state.startRight * eased);
    if (state.progress >= 1) resetBlink();
    return { eyeL, eyeR };
  }

  return (ctx) => {
    // ── EXPRESSION OFF: main-identical behavior ────────────────────────────
    if (!opts.readExpressionEnabled()) {
      if (!ctx.isIdleMotion || ctx.handled) return;

      const baseLeft  = clamp01(ctx.modelParameters.leftEyeOpen);
      const baseRight = clamp01(ctx.modelParameters.rightEyeOpen);

      // Auto-blink OFF: write base + markHandled
      if (!ctx.autoBlinkEnabled) {
        resetBlink();
        ctx.model.setParameterValueById('ParamEyeLOpen', baseLeft);
        ctx.model.setParameterValueById('ParamEyeROpen', baseRight);
        ctx.markHandled();
        return;
      }

      // Force-mode OR no native eyeBlink: state-machine blink + markHandled
      if (ctx.forceAutoBlinkEnabled || !ctx.internalModel.eyeBlink) {
        const dtMs = ctx.timing.deltaMs;
        const { eyeL, eyeR } = advanceForced(dtMs, baseLeft, baseRight);
        ctx.model.setParameterValueById('ParamEyeLOpen', eyeL);
        ctx.model.setParameterValueById('ParamEyeROpen', eyeR);
        ctx.markHandled();
        return;
      }

      // Native eyeBlink + multiply by base + markHandled
      ctx.internalModel.eyeBlink.updateParameters(ctx.model, ctx.timing.deltaMs / 1000);
      const blinkLeft  = ctx.model.getParameterValueById('ParamEyeLOpen');
      const blinkRight = ctx.model.getParameterValueById('ParamEyeROpen');
      ctx.model.setParameterValueById('ParamEyeLOpen', clamp01(blinkLeft * baseLeft));
      ctx.model.setParameterValueById('ParamEyeROpen', clamp01(blinkRight * baseRight));
      ctx.markHandled();
      return;
    }

    // ── EXPRESSION ON: multiply-modulate behavior ──────────────────────────
    // (Expression plugin runs in final stage AFTER this; we want our values
    // to feed in cleanly so it can multiply on top.)
    if (!ctx.isIdleMotion) return;

    const baseLeft  = clamp01(ctx.modelParameters.leftEyeOpen);
    const baseRight = clamp01(ctx.modelParameters.rightEyeOpen);

    if (!ctx.autoBlinkEnabled) {
      resetBlink();
      const curL = ctx.model.getParameterValueById('ParamEyeLOpen');
      const curR = ctx.model.getParameterValueById('ParamEyeROpen');
      ctx.model.setParameterValueById('ParamEyeLOpen', clamp01(curL * baseLeft));
      ctx.model.setParameterValueById('ParamEyeROpen', clamp01(curR * baseRight));
      return;
    }

    if (!ctx.forceAutoBlinkEnabled && ctx.internalModel.eyeBlink) {
      resetBlink();
      const curL = ctx.model.getParameterValueById('ParamEyeLOpen');
      const curR = ctx.model.getParameterValueById('ParamEyeROpen');
      ctx.model.setParameterValueById('ParamEyeLOpen', clamp01(curL * baseLeft));
      ctx.model.setParameterValueById('ParamEyeROpen', clamp01(curR * baseRight));
      return;
    }

    // Force-mode while expression on
    const curL = ctx.model.getParameterValueById('ParamEyeLOpen');
    const curR = ctx.model.getParameterValueById('ParamEyeROpen');

    const BLINK_THRESHOLD = 0.15;
    if (state.phase === 'idle' && curL <= BLINK_THRESHOLD && curR <= BLINK_THRESHOLD) {
      resetBlink();
      return;
    }
    if (state.phase === 'idle') {
      preBlinkLeft  = curL;
      preBlinkRight = curR;
    }

    const wasActive = state.phase !== 'idle';
    const dtMs = ctx.timing.deltaMs;
    const { eyeL: factorL, eyeR: factorR } = advanceForced(dtMs, 1, 1);

    if (wasActive && state.phase === 'idle') {
      ctx.model.setParameterValueById('ParamEyeLOpen', clamp01(preBlinkLeft  * baseLeft));
      ctx.model.setParameterValueById('ParamEyeROpen', clamp01(preBlinkRight * baseRight));
      return;
    }
    if (state.phase === 'idle') return;
    ctx.model.setParameterValueById('ParamEyeLOpen', clamp01(preBlinkLeft  * factorL * baseLeft));
    ctx.model.setParameterValueById('ParamEyeROpen', clamp01(preBlinkRight * factorR * baseRight));
  };
}

/**
 * Expression overlay — always runs in final stage so it sits on top of motion
 * + blink writes. Calls the expression-controller's `applyExpressions` which
 * handles blend modes + active→inactive transition reset.
 */
export function createExpressionPlugin(
  controller: ExpressionController,
): MotionPlugin {
  return (ctx) => {
    controller.applyExpressions(ctx.model);
  };
}

/** 在原生 motion update 前清除上一帧 expression 参数，防止 Add 逐帧累积。 */
export function createExpressionResetPlugin(
  controller: ExpressionController,
): MotionPlugin {
  return (ctx) => {
    controller.prepareFrame(ctx.model);
  };
}

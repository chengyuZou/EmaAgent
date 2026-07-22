// ── Math utilities ──────────────────────────────────────────────────────────
//
// Tiny replacements for three.js MathUtils — we don't want to pull in three
// just for two functions.

/**
 * Inclusive-lower / exclusive-upper random float.
 *
 * @example randFloat(-1, 1)   // → e.g. 0.4827
 */
export function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Linear interpolation between `a` and `b` by ratio `t` ∈ [0, 1].
 *
 * @example lerp(0, 10, 0.5)   // → 5
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clamp to [0, 1]. */
export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Random delay (ms) between two saccades (rapid eye movements). Real human
 * saccade frequency is roughly 1 every 200ms-1500ms during active focus, but
 * for an idle "looking around" feel we widen to 800-3500ms.
 */
export function randomSaccadeInterval(): number {
  return randFloat(800, 3500);
}

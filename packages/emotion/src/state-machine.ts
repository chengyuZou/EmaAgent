import type { EmotionState } from '@ema-agent/contracts';

// ── Internal mutable state ────────────────────────────────────────────────────

export interface EmotionStateInternal {
  primary: string;
  intensity: number;
  updatedAt: number;
}

export const DEFAULT_EMOTION = 'neutral';

export function makeInitialState(): EmotionStateInternal {
  return { primary: DEFAULT_EMOTION, intensity: 1.0, updatedAt: Date.now() };
}

// ── Transition ────────────────────────────────────────────────────────────────

/**
 * Attempt to transition to a new emotion.
 *
 * Returns a new state object if the transition is valid and represents a change,
 * or `null` if the transition is rejected (unknown emotion or no actual change).
 */
export function transitionEmotion(
  current: EmotionStateInternal,
  next: string,
  vocabulary: readonly string[],
): EmotionStateInternal | null {
  if (!vocabulary.includes(next)) return null;
  if (current.primary === next) return null;

  return { primary: next, intensity: 1.0, updatedAt: Date.now() };
}

// ── Serialisation ─────────────────────────────────────────────────────────────

export function toPublicState(internal: EmotionStateInternal): EmotionState {
  return { primary: internal.primary, intensity: internal.intensity };
}

import type { EmotionState } from './events.js';

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
 * 尝试过渡到新的情绪。
 *
 * 如果过渡有效且表示更改，则返回新的状态对象，
 * 如果过渡被拒绝（未知情绪或没有实际更改），则返回 `null`。
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

import type { CharacterCard } from './types.js';

export interface OocResult {
  isOoc: boolean;
  /** Matched forbidden topic, if any. */
  topic?: string;
}

/**
 * Lightweight OOC (Out-of-Character) detector.
 *
 * V1: keyword scan against forbiddenTopics list only.
 * V1.5: will add LLM-based post-hoc semantic check.
 */
export function detectOoc(text: string, card: CharacterCard): OocResult {
  const lower = text.toLowerCase();
  for (const topic of card.forbiddenTopics) {
    if (lower.includes(topic.toLowerCase())) {
      return { isOoc: true, topic };
    }
  }
  return { isOoc: false };
}

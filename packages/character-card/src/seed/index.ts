/**
 * Built-in character card seeds.
 *
 * One file per built-in character. Add a new built-in by:
 *   1. Create `<id>-seed.ts` here with a `CharacterCardInput`
 *   2. Drop the character's resources into `apps/desktop/public/cards/<id>/`
 *      (live2d/ + voiceRefs/ + live2d/runtime-config.json)
 *   3. Push the seed into BUILTIN_CARDS below
 *
 * The sidecar auto-registers every entry in BUILTIN_CARDS at startup
 * (idempotent — skips ones already in the DB). No dead code: a new character
 * is just data + a push, no wiring changes.
 */
import type { CharacterCardInput } from '../types.js';
import { EMA_CARD_INPUT, EMA_CARD_ID } from './ema-seed.js';

export { EMA_CARD_INPUT, EMA_CARD_ID };

/**
 * All built-in character cards. The startup seeder iterates this list and
 * upserts each into character_cards + live2d_models (is_builtin=1).
 */
export const BUILTIN_CARDS: CharacterCardInput[] = [
  EMA_CARD_INPUT,
  // Future built-in characters go here — just push the seed.
];

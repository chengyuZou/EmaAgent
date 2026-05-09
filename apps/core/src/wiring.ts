import type { Database } from '@ema-agent/storage';
import { HookBus } from '@ema-agent/hook';

export interface AppBindings {
  db: Database;
  hooks: HookBus;
}

/**
 * Assemble all dependencies and register hooks.
 *
 * V1 Phase-1 skeleton: only db + hookBus wired.
 * Later phases will add: llm, session, memory, characterCard, emotion, tts, stage, telemetry.
 */
export function wire(db: Database): AppBindings {
  const hooks = new HookBus();

  // Hook registrations will be added here as packages are implemented, e.g.:
  // new CharacterCardStore({ db }).registerHooks(hooks);
  // new EmotionEngine({ llm, card }).registerHooks(hooks);
  // new MemoryPlanner(db, ebd, nar).registerHooks(hooks);

  return { db, hooks };
}

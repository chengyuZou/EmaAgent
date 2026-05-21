import type { AppBindings } from './bindings.js';

// ── Aggregated emitter subscriptions ─────────────────────────────────────────

/**
 * Wire module-level emitters (not HookBus events) to their subscribers.
 *
 * Why a separate file from register-hooks.ts:
 *   HookBus  → "I run before X happens, may modify the payload, then continue"
 *   emitters → "I broadcast that X happened; subscribers react independently"
 *
 * Two destinations:
 *   1. In-process side-effects (emotion reset, stage reload, etc.)
 *   2. SystemEventBus — forwarded to /api/system/events for the bubble UI
 *
 * Returns an aggregate unregister function for tests / hot reload.
 */
export function registerAllEmitters(bindings: AppBindings): () => void {
  const offs: Array<() => void> = [];

  // ── Character card switched → reset per-card subsystems + broadcast ───────
  offs.push(
    bindings.card.onSwitched((next, _previous) => {
      // 1. In-process: emotion follows the active card's vocabulary
      bindings.emotion.updateVocabulary(next.emotionVocabulary);
      bindings.emotion.reset();

      // 2. Broadcast to frontend via system SSE
      bindings.systemBus.emit({
        type:   'character_card_switched',
        cardId: next.id,
        name:   next.name,
      });

      // Future subscribers (V1.5):
      //   stage.loadModel(next.live2dModelId);
      //   tts.setReferenceAudio(next.referenceAudioPath);
    }),
  );

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* tolerate */ }
    }
  };
}

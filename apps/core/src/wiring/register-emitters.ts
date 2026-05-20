import type { AppBindings } from './bindings.js';

// ── Aggregated emitter subscriptions ─────────────────────────────────────────

/**
 * Wire module-level emitters (not HookBus events) to their subscribers.
 *
 * Why a separate file from register-hooks.ts:
 *   HookBus  → "I run before X happens, may modify the payload, then continue"
 *   emitters → "I broadcast that X happened; subscribers react independently"
 *
 * Both belong on the bus AT wiring time, but they have different semantics
 * and different debugging shapes. Keeping them apart makes it obvious which
 * mechanism a given subscription uses.
 *
 * Current subscriptions:
 *   CharacterCardStore.onSwitched → emotion vocab reload + reset
 *     (Future): stage.loadModel + tts.setReferenceAudio
 *
 * Returns an aggregate unregister function for tests / hot reload.
 */
export function registerAllEmitters(bindings: AppBindings): () => void {
  const offs: Array<() => void> = [];

  // ── Character card switched → reset per-card subsystems ───────────────────
  offs.push(
    bindings.card.onSwitched((next, _previous) => {
      // Emotion vocabulary depends on the active card. Reset zeros out the
      // emotional state too — a fresh card starts neutral.
      bindings.emotion.updateVocabulary(next.emotionVocabulary);
      bindings.emotion.reset();

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

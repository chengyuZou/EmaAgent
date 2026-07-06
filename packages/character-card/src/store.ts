import type { Database, CharacterCardsRepo } from '@ema-agent/storage';
import { CharacterCardsRepo as Repo } from '@ema-agent/storage';
import type { CharacterCardId } from '@ema-agent/contracts';
import { asCharacterCardId } from '@ema-agent/contracts';
import type { CharacterCard, CharacterCardInput } from './types.js';
import { CharacterCardRepository } from './repository.js';
import { EMA_CARD_ID, EMA_CARD_INPUT, BUILTIN_CARDS } from './seed/index.js';

// ── Event listener types ─────────────────────────────────────────────────────

/**
 * Fires after the active card changes. `previous` is null only on first
 * activation (e.g. during ensureSeed). Subscribers re-initialise per-card
 * state:
 *
 *   emotion.updateVocabulary + emotion.reset
 *   stage.loadModel       (V1.5)
 *   tts.setReferenceAudio (V1.5)
 *
 * NOT a HookBus — this is a fire-and-forget broadcast. Multiple subscribers
 * (emotion / stage / tts) each react independently; the store doesn't wait
 * for them and doesn't aggregate their results.
 *
 * Listeners are called synchronously inside activate(); throwing handlers are
 * logged and swallowed so a buggy subscriber can't block the activation.
 */
export type CardSwitchedListener = (
  next: CharacterCard,
  previous: CharacterCard | null,
) => void;

export class CharacterCardStore {
  private readonly repository: CharacterCardRepository;
  private readonly switchedListeners = new Set<CardSwitchedListener>();

  constructor({ db }: { db: Database }) {
    const repo: CharacterCardsRepo = new Repo(db.sqlite);
    this.repository = new CharacterCardRepository(repo);
  }

  // ── Event subscription ──────────────────────────────────────────────────────

  /**
   * Subscribe to active-card changes. Returns an unregister function for
   * deterministic cleanup (tests, mode swaps, etc.).
   */
  onSwitched(handler: CardSwitchedListener): () => void {
    this.switchedListeners.add(handler);
    return () => {
      this.switchedListeners.delete(handler);
    };
  }

  private emitSwitched(next: CharacterCard, previous: CharacterCard | null): void {
    for (const fn of this.switchedListeners) {
      try { fn(next, previous); }
      catch (err) {
        console.error('[character-card] switched listener threw:', err);
      }
    }
  }

  ensureSeed(): void {
    // Seed ALL built-in cards (not just Ema). Each is inserted if missing.
    // New built-in characters are added by pushing into BUILTIN_CARDS in
    // seed/index.ts — no wiring changes needed here.
    for (const cardInput of BUILTIN_CARDS) {
      const cardId = asCharacterCardId(cardInput === EMA_CARD_INPUT ? EMA_CARD_ID : cardInput.name);
      if (!this.repository.findById(cardId)) {
        this.repository.insert(cardInput, { id: cardId as string, isBuiltin: true });
      }
    }

    // Activate Ema if no card is active yet.
    const before = this.repository.findActive();
    if (!before) {
      const emaId = asCharacterCardId(EMA_CARD_ID);
      this.repository.activate(emaId);
      const after = this.repository.findActive();
      if (after) this.emitSwitched(after, null);
    }
  }

  current(): CharacterCard {
    const card = this.repository.findActive();
    if (!card) throw new Error('no active character card — call ensureSeed() at startup');
    return card;
  }

  list(): CharacterCard[] {
    return this.repository.list();
  }

  get(id: CharacterCardId): CharacterCard | undefined {
    return this.repository.findById(id);
  }

  activate(id: CharacterCardId): CharacterCardId {
    const target = this.repository.findById(id);
    if (!target) throw new Error(`character card not found: ${id}`);

    const before = this.repository.findActive() ?? null;
    this.repository.activate(id);
    const after = this.repository.findActive() ?? target;

    // Only emit when the active id actually changed. Re-activating the same
    // card is a no-op — saves subscribers from spurious reset cycles.
    if (!before || before.id !== after.id) {
      this.emitSwitched(after, before);
    }
    return id;
  }

  create(input: CharacterCardInput): CharacterCard {
    return this.repository.insert(input);
  }

  update(id: CharacterCardId, patch: Partial<CharacterCardInput>): CharacterCard {
    this.repository.update(id, patch);
    return this.repository.findById(id)!;
  }

  duplicate(id: CharacterCardId): CharacterCard {
    const original = this.repository.findById(id);
    if (!original) throw new Error(`character card not found: ${id}`);
    return this.repository.insert(
      {
        name: `${original.name}(Copy)`,
        version: original.version,
        description: original.description ?? undefined,
        systemPrompt: original.systemPrompt,
        speechPatterns: original.speechPatterns,
        forbiddenTopics: original.forbiddenTopics,
        emotionVocabulary: original.emotionVocabulary,
        motionVocabulary: original.motionVocabulary,
        live2dModelId: original.live2dModelId ?? undefined,
        voiceProfile: original.voiceProfile,
      },
      { isBuiltin: false },
    );
  }

  delete(id: CharacterCardId): void {
    this.repository.delete(id);
  }

  importFromFile(_buf: Uint8Array): Promise<CharacterCard> {
    return Promise.reject(new Error('importFromFile not implemented in V1'));
  }

  exportToFile(_id: CharacterCardId): Promise<Uint8Array> {
    return Promise.reject(new Error('exportToFile not implemented in V1'));
  }
}

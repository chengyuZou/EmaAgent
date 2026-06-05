import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '@ema-agent/storage';
import { CharacterCardStore } from '../src/store.js';
import { EMA_CARD_ID } from '../src/seed.js';
import type { CharacterCardInput } from '../src/types.js';
import type { CharacterCardId } from '@ema-agent/contracts';

// ── helpers ───────────────────────────────────────────────────────────────────

function minimalInput(overrides: Partial<CharacterCardInput> = {}): CharacterCardInput {
  return {
    name: 'Test Card',
    systemPrompt: 'You are a test.',
    ...overrides,
  };
}

describe('CharacterCardStore', () => {
  let db: Database;
  let store: CharacterCardStore;

  beforeEach(() => {
    db = new Database({ memory: true, kind: 'profile' });
    db.migrate();
    store = new CharacterCardStore({ db });
    store.ensureSeed();
  });

  afterEach(() => {
    db.close();
  });

  // ─── seed & init ──────────────────────────────────────────────────────────

  describe('ensureSeed', () => {
    it('sets the built-in Ema card as active on first call', () => {
      const current = store.current();
      expect(current.id).toBe(EMA_CARD_ID);
      expect(current.isBuiltin).toBe(true);
      expect(current.isActive).toBe(true);
    });

    it('is idempotent — calling twice does not duplicate or throw', () => {
      store.ensureSeed();
      store.ensureSeed();
      const cards = store.list();
      const emaCards = cards.filter((c) => c.id === EMA_CARD_ID);
      expect(emaCards).toHaveLength(1);
    });
  });

  describe('current', () => {
    it('returns the active card', () => {
      const card = store.current();
      expect(card.isActive).toBe(true);
    });

    it('throws when no card is active', () => {
      // deactivate the only card by activating nothing (simulate corrupted state)
      const db2 = new Database({ memory: true, kind: 'profile' });
      db2.migrate();
      const emptyStore = new CharacterCardStore({ db: db2 });
      // never called ensureSeed
      expect(() => emptyStore.current()).toThrow('no active character card');
      db2.close();
    });
  });

  // ─── list & get ───────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns all cards including the seed', () => {
      store.create(minimalInput({ name: 'Second' }));
      const all = store.list();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('get', () => {
    it('returns the card by id', () => {
      const card = store.get(EMA_CARD_ID as CharacterCardId);
      expect(card).toBeDefined();
      expect(card!.id).toBe(EMA_CARD_ID);
    });

    it('returns undefined for unknown id', () => {
      expect(store.get('nonexistent' as CharacterCardId)).toBeUndefined();
    });
  });

  // ─── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a card with full input', () => {
      const input: CharacterCardInput = {
        name: 'Full Card',
        systemPrompt: 'Full prompt.',
        speechPatterns: ['hello', 'bye'],
        forbiddenTopics: ['violence'],
        emotionVocabulary: ['happy', 'sad'],
        motionVocabulary: ['wave', 'nod'],
      };
      const card = store.create(input);
      expect(card.name).toBe('Full Card');
      expect(card.speechPatterns).toEqual(['hello', 'bye']);
      expect(card.emotionVocabulary).toEqual(['happy', 'sad']);
      expect(card.motionVocabulary).toEqual(['wave', 'nod']);
      expect(card.isBuiltin).toBe(false);
      expect(card.isActive).toBe(false);
    });

    it('creates a card with minimal input (only name + systemPrompt)', () => {
      const card = store.create(minimalInput());
      expect(card.name).toBe('Test Card');
      expect(card.systemPrompt).toBe('You are a test.');
      expect(card.speechPatterns).toEqual([]);
      expect(card.emotionVocabulary).toEqual([]);
      expect(card.motionVocabulary).toEqual([]);
    });
  });

  // ─── activate ─────────────────────────────────────────────────────────────

  describe('activate', () => {
    it('switches the active card and returns the new id', () => {
      const card = store.create(minimalInput({ name: 'New Active' }));
      const result = store.activate(card.id);
      expect(result).toBe(card.id);
      expect(store.current().id).toBe(card.id);

      const old = store.get(EMA_CARD_ID as CharacterCardId);
      expect(old?.isActive).toBe(false);
    });

    it('throws when activating a non-existent card', () => {
      expect(() => store.activate('ghost' as CharacterCardId)).toThrow();
    });
  });

  // ─── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates the card name', () => {
      const card = store.create(minimalInput());
      const updated = store.update(card.id, { name: 'Renamed' });
      expect(updated.name).toBe('Renamed');
      expect(store.get(card.id)?.name).toBe('Renamed');
    });

    it('updates systemPrompt and speechPatterns', () => {
      const card = store.create(minimalInput());
      const updated = store.update(card.id, {
        systemPrompt: 'New prompt',
        speechPatterns: ['ahoy'],
      });
      expect(updated.systemPrompt).toBe('New prompt');
      expect(updated.speechPatterns).toEqual(['ahoy']);
    });

    it('does not affect fields not included in patch', () => {
      const card = store.create(minimalInput({ name: 'Original' }));
      store.update(card.id, { systemPrompt: 'Changed' });
      const fetched = store.get(card.id)!;
      expect(fetched.name).toBe('Original');
    });
  });

  // ─── duplicate ────────────────────────────────────────────────────────────

  describe('duplicate', () => {
    it('creates a copy with (Copy) suffix and distinct id', () => {
      const ema = store.get(EMA_CARD_ID as CharacterCardId)!;
      const dup = store.duplicate(ema.id);
      expect(dup.id).not.toBe(ema.id);
      expect(dup.name).toContain(ema.name);
      expect(dup.name).toContain('(Copy)');
      expect(dup.systemPrompt).toBe(ema.systemPrompt);
      expect(dup.isBuiltin).toBe(false);
    });

    it('copies vocabularies and optional fields', () => {
      const ema = store.get(EMA_CARD_ID as CharacterCardId)!;
      const dup = store.duplicate(ema.id);
      expect(dup.emotionVocabulary).toEqual(ema.emotionVocabulary);
      expect(dup.motionVocabulary).toEqual(ema.motionVocabulary);
      expect(dup.speechPatterns).toEqual(ema.speechPatterns);
    });

    it('copies voice profile', () => {
      const card = store.create(minimalInput({
        voiceProfile: {
          primaryId: 'ref-1',
          refAudios: [{
            id: 'ref-1',
            label: 'Main',
            refAudioPath: 'card/ref.wav',
            promptText: 'hello',
            promptLang: 'en',
          }],
        },
      }));

      const dup = store.duplicate(card.id);

      expect(dup.voiceProfile).toEqual(card.voiceProfile);
    });

    it('throws when duplicating a non-existent card', () => {
      expect(() => store.duplicate('ghost' as CharacterCardId)).toThrow(
        'character card not found',
      );
    });
  });

  // ─── delete ───────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes a non-builtin card', () => {
      const card = store.create(minimalInput());
      store.delete(card.id);
      expect(store.get(card.id)).toBeUndefined();
    });
  });
});

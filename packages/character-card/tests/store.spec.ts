import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '@ema-agent/storage';
import { CharacterCardStore } from '../src/store.js';
import { EMA_CARD_ID } from '../src/seed.js';
import { CharacterCardInput } from '../src/types.js';

describe('CharacterCardStore', () => {
  let db: Database;
  let store: CharacterCardStore;

  beforeEach(() => {
    // We use an in-memory SQLite database for testing, created through the actual storage package.
    db = new Database({ memory: true });
    db.migrate();
    // Ensure migrations have applied. (Assuming the Database class runs migrations on creation or we do it here).
    store = new CharacterCardStore({ db });
    store.ensureSeed();
  });

  it('should initialize with built-in active card', () => {
    const current = store.current();
    expect(current).toBeDefined();
    expect(current.id).toBe(EMA_CARD_ID);
    expect(current.isBuiltin).toBe(true);
    expect(current.isActive).toBe(true);
  });

  it('should create and retrieve a new card', () => {
    const input: CharacterCardInput = {
      name: 'Test Character',
      systemPrompt: 'You are a test character.',
      speechPatterns: ['hello'],
      forbiddenTopics: ['politics'],
      emotionVocabulary: ['happy'],
      motionVocabulary: ['idle'],
    };

    const newCard = store.create(input);
    expect(newCard.id).toBeDefined();
    expect(newCard.name).toBe('Test Character');

    const retrieved = store.get(newCard.id);
    expect(retrieved).toEqual(newCard);
  });

  it('should activate a different card', async () => {
    const newCard = store.create({
      name: 'Test Character',
      systemPrompt: 'You are a test character.',
    });

    await store.activate(newCard.id);

    const current = store.current();
    expect(current.id).toBe(newCard.id);
    expect(current.isActive).toBe(true);

    const oldEma = store.get(EMA_CARD_ID as any);
    expect(oldEma?.isActive).toBe(false);
  });

  it('should duplicate a card properly', () => {
    const emaCard = store.get(EMA_CARD_ID as any);
    expect(emaCard).toBeDefined();

    const dup = store.duplicate(emaCard!.id);
    expect(dup.id).not.toBe(emaCard!.id);
    expect(dup.name).toContain(emaCard!.name);
    expect(dup.name).toContain('(Copy)');
    expect(dup.systemPrompt).toBe(emaCard!.systemPrompt);
    expect(dup.isBuiltin).toBe(false);
  });
});

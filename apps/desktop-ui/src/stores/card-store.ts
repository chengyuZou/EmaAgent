/**
 * Card store — character card CRUD + activate + voice-refs passthrough.
 */
import { create } from 'zustand';
import { cardsApi, type CharacterCard, type CharacterCardInput, type CharacterVoiceProfile } from '../api/cards.js';
import type { CharacterCardId } from '@ema-agent/ids';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CardStoreState {
  cards:         CharacterCard[];
  activeCardId:  CharacterCardId | null;
  /** Voice-ref profiles cached per card, populated on demand. */
  voiceProfiles: Map<string, CharacterVoiceProfile>;
  loading:       boolean;
  error:         string | null;

  load():                                          Promise<void>;
  activate(id: CharacterCardId):                   Promise<void>;
  create(input: CharacterCardInput):               Promise<CharacterCard>;
  patch(id: CharacterCardId, input: Partial<CharacterCardInput>): Promise<void>;
  delete(id: CharacterCardId):                     Promise<void>;

  /**
   * Fetch voice refs for a card and cache them.
   * Returns cached value on subsequent calls.
   * Pass force=true to bypass cache (e.g. after an upload/delete).
   */
  loadVoiceRefs(cardId: CharacterCardId, force?: boolean): Promise<CharacterVoiceProfile>;
  uploadVoiceRef(cardId: CharacterCardId, file: Blob, meta: {
    label: string;
    promptText: string;
    promptLang: string;
    setPrimary?: boolean;
  }): Promise<void>;
  deleteVoiceRef(cardId: CharacterCardId, refId: string): Promise<void>;
  setPrimaryVoiceRef(cardId: CharacterCardId, refId: string): Promise<void>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useCardStore = create<CardStoreState>((set, get) => ({
  cards:         [],
  activeCardId:  null,
  voiceProfiles: new Map(),
  loading:       false,
  error:         null,

  async load() {
    set({ loading: true, error: null });
    try {
      const cards = await cardsApi.list();
      const active = cards.find((c) => c.isActive);
      set({
        cards,
        activeCardId: active?.id ?? null,
        loading: false,
      });
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load cards',
        loading: false,
      });
    }
  },

  async activate(id) {
    try {
      await cardsApi.activate(id);
      // Reload to get fresh isActive flags
      await get().load();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to activate card' });
      throw err;
    }
  },

  async create(input) {
    try {
      const card = await cardsApi.create(input);
      await get().load();
      return card;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to create card' });
      throw err;
    }
  },

  async patch(id, input) {
    try {
      await cardsApi.patch(id, input);
      await get().load();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to update card' });
      throw err;
    }
  },

  async delete(id) {
    try {
      await cardsApi.delete(id);
      await get().load();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete card' });
      throw err;
    }
  },

  async loadVoiceRefs(cardId, force = false) {
    const key = cardId as string;
    if (!force) {
      const cached = get().voiceProfiles.get(key);
      if (cached) return cached;
    }
    try {
      const profile = await cardsApi.listVoiceRefs(cardId);
      set((s) => {
        const m = new Map(s.voiceProfiles);
        m.set(key, profile);
        return { voiceProfiles: m };
      });
      return profile;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to load voice refs' });
      throw err;
    }
  },

  async uploadVoiceRef(cardId, file, meta) {
    try {
      await cardsApi.uploadVoiceRef(cardId, file, meta);
      // Bust cache so next loadVoiceRefs re-fetches.
      set((s) => {
        const m = new Map(s.voiceProfiles);
        m.delete(cardId as string);
        return { voiceProfiles: m };
      });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to upload voice ref' });
      throw err;
    }
  },

  async deleteVoiceRef(cardId, refId) {
    try {
      await cardsApi.deleteVoiceRef(cardId, refId);
      set((s) => {
        const m = new Map(s.voiceProfiles);
        m.delete(cardId as string);
        return { voiceProfiles: m };
      });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete voice ref' });
      throw err;
    }
  },

  async setPrimaryVoiceRef(cardId, refId) {
    try {
      await cardsApi.setPrimaryVoiceRef(cardId, refId);
      set((s) => {
        const m = new Map(s.voiceProfiles);
        m.delete(cardId as string);
        return { voiceProfiles: m };
      });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to set primary voice ref' });
      throw err;
    }
  },
}));

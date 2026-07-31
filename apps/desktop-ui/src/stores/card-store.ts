/** 聚合角色卡编辑、激活、表现切换与参考音频操作。 */
import { create } from 'zustand';
import { cardsApi, type CharacterCard, type CharacterCardInput } from '../api/cards.js';
import type { CharacterCardId } from '@ema-agent/ids';

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface CardStoreState {
  cards:         CharacterCard[];
  activeCardId:  CharacterCardId | null;
  loading:       boolean;
  error:         string | null;

  load():                                          Promise<void>;
  activate(id: CharacterCardId):                   Promise<void>;
  create(input: CharacterCardInput):               Promise<CharacterCard>;
  patch(id: CharacterCardId, input: Partial<CharacterCardInput>): Promise<void>;
  delete(id: CharacterCardId):                     Promise<void>;
  setPrimaryLive2d(id: CharacterCardId, resourceId: string): Promise<void>;
  setPrimaryPortrait(id: CharacterCardId, resourceId: string): Promise<void>;

  uploadVoiceRef(cardId: CharacterCardId, file: Blob, meta: {
    label: string;
    promptText: string;
    promptLang: string;
    setPrimary?: boolean;
  }): Promise<void>;
  deleteVoiceRef(cardId: CharacterCardId, refId: string): Promise<void>;
  setPrimaryVoiceRef(cardId: CharacterCardId, refId: string): Promise<void>;
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useCardStore = create<CardStoreState>((set, get) => ({
  cards:         [],
  activeCardId:  null,
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
      // 重读以取得唯一可信的 isActive 状态。
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

  async setPrimaryLive2d(id, resourceId) {
    try {
      await cardsApi.setPrimaryLive2d(id, resourceId);
      await get().load();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to switch Live2D' });
      throw err;
    }
  },

  async setPrimaryPortrait(id, resourceId) {
    try {
      await cardsApi.setPrimaryPortrait(id, resourceId);
      await get().load();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to switch portrait' });
      throw err;
    }
  },

  async uploadVoiceRef(cardId, file, meta) {
    try {
      await cardsApi.uploadVoiceRef(cardId, file, meta);
      await get().load();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to upload voice ref' });
      throw err;
    }
  },

  async deleteVoiceRef(cardId, refId) {
    try {
      await cardsApi.deleteVoiceRef(cardId, refId);
      await get().load();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete voice ref' });
      throw err;
    }
  },

  async setPrimaryVoiceRef(cardId, refId) {
    try {
      await cardsApi.setPrimaryVoiceRef(cardId, refId);
      await get().load();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to set primary voice ref' });
      throw err;
    }
  },
}));

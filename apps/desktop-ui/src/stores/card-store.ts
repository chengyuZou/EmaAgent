/** 聚合角色卡编辑、激活、表现切换与参考音频操作。 */
import { create } from 'zustand';
import {
  cardsApi,
  type CharacterCard,
  type CharacterCardInput,
} from '../api/cards.js';
import type { CharacterHealth } from '@ema-agent/characters';
import type { CharacterCardId } from '@ema-agent/ids';

export interface ResourcePatch {
  name?: string;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  enabled?: boolean;
}

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface CardStoreState {
  cards:         CharacterCard[];
  activeCardId:  CharacterCardId | null;
  loading:       boolean;
  error:         string | null;
  /** 每卡健康投影;资源操作后显式刷新,不靠 card.updatedAt 碰运气。 */
  healthMap:     Record<string, CharacterHealth>;

  load():                                          Promise<void>;
  refreshHealth(id: CharacterCardId):              Promise<void>;
  activate(id: CharacterCardId):                   Promise<void>;
  create(input: CharacterCardInput):               Promise<CharacterCard>;
  patch(id: CharacterCardId, input: Partial<CharacterCardInput>): Promise<void>;
  delete(id: CharacterCardId):                     Promise<void>;
  setPrimaryLive2d(id: CharacterCardId, resourceId: string): Promise<void>;
  setPrimaryIllustration(id: CharacterCardId, resourceId: string): Promise<void>;

  uploadVoiceReference(cardId: CharacterCardId, file: Blob, meta: {
    name: string;
    promptText: string;
    promptLang: string;
    setPrimary?: boolean;
  }): Promise<void>;
  deleteVoiceReference(cardId: CharacterCardId, refId: string): Promise<void>;
  setPrimaryVoiceReference(cardId: CharacterCardId, refId: string): Promise<void>;

  // ── 三类资源管理(C3b 能力句柄式)─────────────────────────────────────────

  importLive2d(id: CharacterCardId, input: {
    sourceHandle: string;
    name: string;
    isPrimary?: boolean;
  }): Promise<void>;
  exportLive2d(id: CharacterCardId, resourceId: string, destinationHandle: string): Promise<string>;
  patchLive2d(id: CharacterCardId, resourceId: string, patch: ResourcePatch): Promise<void>;
  deleteLive2d(id: CharacterCardId, resourceId: string): Promise<void>;

  importIllustration(id: CharacterCardId, input: {
    sourceHandle: string;
    name: string;
    isPrimary?: boolean;
  }): Promise<void>;
  exportIllustration(id: CharacterCardId, resourceId: string, destinationHandle: string): Promise<string>;
  patchIllustration(id: CharacterCardId, resourceId: string, patch: ResourcePatch): Promise<void>;
  deleteIllustration(id: CharacterCardId, resourceId: string): Promise<void>;

  exportVoiceReference(cardId: CharacterCardId, resourceId: string, destinationHandle: string): Promise<string>;
  patchVoiceReference(cardId: CharacterCardId, resourceId: string, patch: Pick<ResourcePatch, 'name' | 'enabled'>): Promise<void>;
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useCardStore = create<CardStoreState>((set, get) => ({
  cards:         [],
  activeCardId:  null,
  loading:       false,
  error:         null,
  healthMap:     {},

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

  // 静默失败保旧值:健康只是展示投影,网络抖动不能清掉用户正在看的状态。
  async refreshHealth(id) {
    try {
      const health = await cardsApi.health(id);
      set((s) => ({ healthMap: { ...s.healthMap, [id as string]: health } }));
    } catch {
      // 保留旧投影,下一次资源操作或编辑器挂载会再试。
    }
  },

  async activate(id) {
    try {
      await cardsApi.activate(id);
      // 重读以取得唯一可信的 isActive 状态。
      await get().load();
      void get().refreshHealth(id);
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
      // systemPrompt 是健康硬门,元数据修改后同步刷新。
      void get().refreshHealth(id);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to update card' });
      throw err;
    }
  },

  async delete(id) {
    try {
      await cardsApi.delete(id);
      set((s) => {
        const healthMap = { ...s.healthMap };
        delete healthMap[id as string];
        return { healthMap };
      });
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
      void get().refreshHealth(id);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to switch Live2D' });
      throw err;
    }
  },

  async setPrimaryIllustration(id, resourceId) {
    try {
      await cardsApi.setPrimaryIllustration(id, resourceId);
      await get().load();
      void get().refreshHealth(id);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '切换立绘失败' });
      throw err;
    }
  },

  async uploadVoiceReference(cardId, file, meta) {
    try {
      await cardsApi.uploadVoiceReference(cardId, file, meta);
      await get().load();
      void get().refreshHealth(cardId);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to upload voice ref' });
      throw err;
    }
  },

  async deleteVoiceReference(cardId, refId) {
    try {
      await cardsApi.deleteVoiceReference(cardId, refId);
      await get().load();
      void get().refreshHealth(cardId);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete voice ref' });
      throw err;
    }
  },

  async setPrimaryVoiceReference(cardId, refId) {
    try {
      await cardsApi.setPrimaryVoiceReference(cardId, refId);
      await get().load();
      void get().refreshHealth(cardId);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to set primary voice ref' });
      throw err;
    }
  },

  // ── 三类资源管理:导入/更新/删除后重读,导出不改库只回传目标路径 ─────────────

  async importLive2d(id, input) {
    try {
      await cardsApi.importLive2d(id, input);
      await get().load();
      void get().refreshHealth(id);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to import Live2D' });
      throw err;
    }
  },

  async exportLive2d(id, resourceId, destinationHandle) {
    try {
      const res = await cardsApi.exportLive2d(id, resourceId, destinationHandle);
      return res.destinationPath;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to export Live2D' });
      throw err;
    }
  },

  async patchLive2d(id, resourceId, patch) {
    try {
      await cardsApi.patchLive2d(id, resourceId, patch);
      await get().load();
      void get().refreshHealth(id);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to update Live2D' });
      throw err;
    }
  },

  async deleteLive2d(id, resourceId) {
    try {
      await cardsApi.deleteLive2d(id, resourceId);
      await get().load();
      void get().refreshHealth(id);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete Live2D' });
      throw err;
    }
  },

  async importIllustration(id, input) {
    try {
      await cardsApi.importIllustration(id, input);
      await get().load();
      void get().refreshHealth(id);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '导入立绘失败' });
      throw err;
    }
  },

  async exportIllustration(id, resourceId, destinationHandle) {
    try {
      const res = await cardsApi.exportIllustration(id, resourceId, destinationHandle);
      return res.destinationPath;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '导出立绘失败' });
      throw err;
    }
  },

  async patchIllustration(id, resourceId, patch) {
    try {
      await cardsApi.patchIllustration(id, resourceId, patch);
      await get().load();
      void get().refreshHealth(id);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '更新立绘失败' });
      throw err;
    }
  },

  async deleteIllustration(id, resourceId) {
    try {
      await cardsApi.deleteIllustration(id, resourceId);
      await get().load();
      void get().refreshHealth(id);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '删除立绘失败' });
      throw err;
    }
  },

  async exportVoiceReference(cardId, resourceId, destinationHandle) {
    try {
      const res = await cardsApi.exportVoiceReference(cardId, resourceId, destinationHandle);
      return res.destinationPath;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to export voice ref' });
      throw err;
    }
  },

  async patchVoiceReference(cardId, resourceId, patch) {
    try {
      await cardsApi.patchVoiceReference(cardId, resourceId, patch);
      await get().load();
      void get().refreshHealth(cardId);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to update voice ref' });
      throw err;
    }
  },
}));

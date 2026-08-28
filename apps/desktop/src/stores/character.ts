/** 聚合角色编辑、激活、表现切换与参考音频操作。 */
import { create } from 'zustand';
import {
  charactersApi,
  type Character,
  type CharacterCreateInput,
  type CharacterPatchInput,
  type CharacterHealth,
  type Live2dImportInput,
  type VoiceImportInput,
} from '../api/characters.js';

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface CharacterStoreState {
  characters:    Character[];
  activeCharacterId: string | null;
  loading:       boolean;
  error:         string | null;
  /** 每角色健康投影;资源操作后显式刷新,不靠 character.updatedAt 碰运气。 */
  healthMap:     Record<string, CharacterHealth>;

  load():                                          Promise<void>;
  refreshHealth(id: string):              Promise<void>;
  activate(id: string):                   Promise<void>;
  create(input: CharacterCreateInput):               Promise<Character>;
  patch(id: string, input: CharacterPatchInput): Promise<void>;
  delete(id: string):                     Promise<void>;
  setPrimaryLive2d(id: string, resourceId: string): Promise<void>;

  /** 导入 Live2D 模型目录 zip（sourceZipFile 为本机绝对路径）。 */
  importLive2d(id: string, input: Live2dImportInput): Promise<void>;

  /** 从本机文件导入参考音频。 */
  importVoice(characterId: string, input: VoiceImportInput): Promise<void>;
  /** 录音/合成直传参考音频（multipart）。 */
  publishVoice(characterId: string, file: File, meta: {
    promptText: string;
    promptLang: string;
    isPrimary?: boolean;
  }): Promise<void>;
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useCharacterStore = create<CharacterStoreState>((set, get) => ({
  characters:      [],
  activeCharacterId: null,
  loading:       false,
  error:         null,
  healthMap:     {},

  async load() {
    set({ loading: true, error: null });
    try {
      const { items } = await charactersApi.list();
      const active = items.find((c) => c.isActive);
      set({
        characters: [...items],
        activeCharacterId: active?.id ?? null,
        loading: false,
      });
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load characters',
        loading: false,
      });
    }
  },

  // 静默失败保旧值:健康只是展示投影,网络抖动不能清掉用户正在看的状态。
  async refreshHealth(id) {
    try {
      const health = await charactersApi.health(id);
      set((s) => ({ healthMap: { ...s.healthMap, [id as string]: health } }));
    } catch {
      // 保留旧投影,下一次资源操作或编辑器挂载会再试。
    }
  },

  async activate(id) {
    try {
      await charactersApi.activate(id);
      // 重读以取得唯一可信的 isActive 状态。
      await get().load();
      void get().refreshHealth(id);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to activate character' });
      throw err;
    }
  },

  async create(input) {
    try {
      const character = await charactersApi.create(input);
      await get().load();
      return character;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to create character' });
      throw err;
    }
  },

  async patch(id, input) {
    try {
      await charactersApi.patch(id, input);
      await get().load();
      // systemPrompt 是健康硬门,元数据修改后同步刷新。
      void get().refreshHealth(id);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to update character' });
      throw err;
    }
  },

  async delete(id) {
    try {
      await charactersApi.remove(id);
      set((s) => {
        const healthMap = { ...s.healthMap };
        delete healthMap[id as string];
        return { healthMap };
      });
      await get().load();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete character' });
      throw err;
    }
  },

  async setPrimaryLive2d(id, resourceId) {
    try {
      await charactersApi.setLive2dPrimary(id, resourceId);
      await get().load();
      void get().refreshHealth(id);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to switch Live2D' });
      throw err;
    }
  },

  async importLive2d(id, input) {
    try {
      await charactersApi.importLive2d(id, input);
      await get().load();
      void get().refreshHealth(id);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to import Live2D' });
      throw err;
    }
  },

  async importVoice(characterId, input) {
    try {
      await charactersApi.importVoice(characterId, input);
      await get().load();
      void get().refreshHealth(characterId);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to import voice ref' });
      throw err;
    }
  },

  async publishVoice(characterId, file, meta) {
    try {
      await charactersApi.publishVoice(characterId, file, meta);
      await get().load();
      void get().refreshHealth(characterId);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to publish voice ref' });
      throw err;
    }
  },
}));

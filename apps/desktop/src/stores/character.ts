/** 聚合角色编辑、激活、表现切换与参考音频操作。 */
import { create } from 'zustand';
import {
  charactersApi,
  type Character,
  type CharacterCreateInput,
  type CharacterPatchInput,
  type CharacterHealth,
  type Live2dImportInput,
  type IllustrationImportInput,
  type VoiceImportInput,
  type ResourcePatchInput,
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
  patchLive2d(id: string, resourceId: string, input: ResourcePatchInput): Promise<void>;
  /** 用户手改 runtime-config.json 后重读：词汇写回并刷新舞台。 */
  reloadLive2dConfig(id: string, resourceId: string): Promise<void>;
  exportLive2d(id: string, resourceId: string, destinationDirectory: string): Promise<string>;
  deleteLive2d(id: string, resourceId: string): Promise<void>;

  setPrimaryIllustration(id: string, resourceId: string): Promise<void>;
  importIllustration(id: string, input: IllustrationImportInput): Promise<void>;
  patchIllustration(id: string, resourceId: string, input: ResourcePatchInput): Promise<void>;
  exportIllustration(id: string, resourceId: string, destinationDirectory: string): Promise<string>;
  deleteIllustration(id: string, resourceId: string): Promise<void>;

  setPrimaryVoice(id: string, resourceId: string): Promise<void>;
  /** 从本机文件导入参考音频。 */
  importVoice(characterId: string, input: VoiceImportInput): Promise<void>;
  /** 录音/合成直传参考音频（multipart）。 */
  publishVoice(characterId: string, file: File, meta: {
    promptText: string;
    promptLang: string;
    isPrimary?: boolean;
  }): Promise<void>;
  patchVoice(id: string, resourceId: string, input: ResourcePatchInput): Promise<void>;
  exportVoice(id: string, resourceId: string, destinationDirectory: string): Promise<string>;
  deleteVoice(id: string, resourceId: string): Promise<void>;
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useCharacterStore = create<CharacterStoreState>((set, get) => {
  /** 资源操作统一节拍：成功 → load + 健康刷新；失败 → error 落 store 并上抛给调用方 toast。 */
  const mutate = async <T>(
    characterId: string,
    errorLabel: string,
    action: () => Promise<T>,
  ): Promise<T> => {
    try {
      const result = await action();
      await get().load();
      void get().refreshHealth(characterId);
      return result;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : errorLabel });
      throw err;
    }
  };

  return {
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
      set((s) => ({ healthMap: { ...s.healthMap, [id]: health } }));
    } catch {
      // 保留旧投影,下一次资源操作或编辑器挂载会再试。
    }
  },

  async activate(id) {
    await mutate(id, 'Failed to activate character', () => charactersApi.activate(id));
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
    await mutate(id, 'Failed to update character', () => charactersApi.patch(id, input));
  },

  async delete(id) {
    try {
      await charactersApi.remove(id);
      set((s) => {
        const healthMap = { ...s.healthMap };
        delete healthMap[id];
        return { healthMap };
      });
      await get().load();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete character' });
      throw err;
    }
  },

  // ── Live2D ─────────────────────────────────────────────────────────────────

  async setPrimaryLive2d(id, resourceId) {
    await mutate(id, 'Failed to switch Live2D', () => charactersApi.setLive2dPrimary(id, resourceId));
  },

  async importLive2d(id, input) {
    await mutate(id, 'Failed to import Live2D', () => charactersApi.importLive2d(id, input));
  },

  async patchLive2d(id, resourceId, input) {
    await mutate(id, 'Failed to update Live2D', () => charactersApi.patchLive2d(id, resourceId, input));
  },

  async reloadLive2dConfig(id, resourceId) {
    await mutate(id, 'Failed to reload Live2D config', () => charactersApi.reloadLive2dConfig(id, resourceId));
  },

  async exportLive2d(id, resourceId, destinationDirectory) {
    const result = await mutate(id, 'Failed to export Live2D', () =>
      charactersApi.exportLive2d(id, resourceId, destinationDirectory));
    return result.exported;
  },

  async deleteLive2d(id, resourceId) {
    await mutate(id, 'Failed to delete Live2D', () => charactersApi.deleteLive2d(id, resourceId));
  },

  // ── 立绘 ───────────────────────────────────────────────────────────────────

  async setPrimaryIllustration(id, resourceId) {
    await mutate(id, 'Failed to switch illustration', () =>
      charactersApi.setIllustrationPrimary(id, resourceId));
  },

  async importIllustration(id, input) {
    await mutate(id, 'Failed to import illustration', () => charactersApi.importIllustration(id, input));
  },

  async patchIllustration(id, resourceId, input) {
    await mutate(id, 'Failed to update illustration', () =>
      charactersApi.patchIllustration(id, resourceId, input));
  },

  async exportIllustration(id, resourceId, destinationDirectory) {
    const result = await mutate(id, 'Failed to export illustration', () =>
      charactersApi.exportIllustration(id, resourceId, destinationDirectory));
    return result.exported;
  },

  async deleteIllustration(id, resourceId) {
    await mutate(id, 'Failed to delete illustration', () =>
      charactersApi.deleteIllustration(id, resourceId));
  },

  // ── 参考音频 ────────────────────────────────────────────────────────────────

  async setPrimaryVoice(id, resourceId) {
    await mutate(id, 'Failed to switch voice ref', () => charactersApi.setVoicePrimary(id, resourceId));
  },

  async importVoice(characterId, input) {
    await mutate(characterId, 'Failed to import voice ref', () => charactersApi.importVoice(characterId, input));
  },

  async publishVoice(characterId, file, meta) {
    await mutate(characterId, 'Failed to publish voice ref', () =>
      charactersApi.publishVoice(characterId, file, meta));
  },

  async patchVoice(id, resourceId, input) {
    await mutate(id, 'Failed to update voice ref', () => charactersApi.patchVoice(id, resourceId, input));
  },

  async exportVoice(id, resourceId, destinationDirectory) {
    const result = await mutate(id, 'Failed to export voice ref', () =>
      charactersApi.exportVoice(id, resourceId, destinationDirectory));
    return result.exported;
  },

  async deleteVoice(id, resourceId) {
    await mutate(id, 'Failed to delete voice ref', () => charactersApi.deleteVoice(id, resourceId));
  },
  };
});

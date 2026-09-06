/** 聚合角色编辑、激活、表现切换与参考音频操作。 */
import { create } from 'zustand';
import {
  charactersApi,
  type Character,
  type CharacterCreateInput,
  type CharacterPatchInput,
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
  load():                                          Promise<void>;
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
  patchVoice(id: string, resourceId: string, input: ResourcePatchInput): Promise<void>;
  exportVoice(id: string, resourceId: string, destinationDirectory: string): Promise<string>;
  deleteVoice(id: string, resourceId: string): Promise<void>;
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useCharacterStore = create<CharacterStoreState>((set, get) => {
  /** 资源操作统一节拍：成功后重新读取角色，失败时保留错误给页面展示。 */
  const mutate = async <T>(
    characterId: string,
    errorLabel: string,
    action: () => Promise<T>,
  ): Promise<T> => {
    try {
      const result = await action();
      await get().load();
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

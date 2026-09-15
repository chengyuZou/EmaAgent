// 角色与资源的展示状态:name 是唯一身份,不存在 id/enabled/isBuiltin。
// 每次写操作成功后整体重读列表(角色数据量小,重读比分片合并简单且不会漂)。
import { create } from 'zustand';
import type { AppEvent } from '@ema-agent/server/application/appEvents.js';
import { useLiveTurns } from '../chat/state/liveTurns.js';
import {
  charactersApi,
  type Character,
  type CharacterCreateInput,
  type CharacterPatchInput,
  type IllustrationImportInput,
  type IllustrationPatchInput,
  type ResourcePatchInput,
  type VoiceImportInput,
  type VoicePatchInput,
} from '../api/characters.js';

export interface CharacterStoreState {
  characters:        Character[];
  /** 当前角色的稳定 name;全局恰好一个。 */
  activeName:        string | null;
  loading:           boolean;
  error:             string | null;

  load(): Promise<void>;
  /** 切换当前角色;活跃 Session 期间的 409 原样上抛。 */
  activate(name: string): Promise<void>;
  create(input: CharacterCreateInput): Promise<Character>;
  patch(name: string, input: CharacterPatchInput): Promise<void>;
  remove(name: string): Promise<void>;

  setPrimaryLive2d(characterName: string, live2dName: string): Promise<void>;
  patchLive2d(characterName: string, live2dName: string, input: ResourcePatchInput): Promise<void>;
  reloadLive2dConfig(characterName: string, live2dName: string): Promise<void>;
  deleteLive2d(characterName: string, live2dName: string): Promise<void>;

  setPrimaryIllustration(characterName: string, illustrationName: string): Promise<void>;
  importIllustration(characterName: string, input: IllustrationImportInput): Promise<void>;
  patchIllustration(characterName: string, illustrationName: string, input: IllustrationPatchInput): Promise<void>;
  deleteIllustration(characterName: string, illustrationName: string): Promise<void>;

  setPrimaryVoice(characterName: string, voiceName: string): Promise<void>;
  importVoice(characterName: string, input: VoiceImportInput): Promise<void>;
  patchVoice(characterName: string, voiceName: string, input: VoicePatchInput): Promise<void>;
  deleteVoice(characterName: string, voiceName: string): Promise<void>;
}

export const useCharacterStore = create<CharacterStoreState>((set, get) => {
  /** 写操作统一节拍:成功后重读列表,失败把错误留给页面,409 原样上抛给确认流。 */
  const mutate = async <T>(
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
    characters: [],
    activeName: null,
    loading:    false,
    error:      null,

    async load() {
      set({ loading: true, error: null });
      try {
        const { items } = await charactersApi.list();
        set({
          characters: [...items],
          activeName: items.find(c => c.isActive)?.name ?? null,
          loading: false,
        });
      } catch (err: unknown) {
        set({
          error: err instanceof Error ? err.message : '角色列表读取失败',
          loading: false,
        });
      }
    },

    async activate(name) {
      await mutate('切换角色失败', () => charactersApi.activate(name));
    },

    async create(input) {
      const character = await charactersApi.create(input);
      await get().load();
      return character;
    },

    async patch(name, input) {
      await mutate('保存角色失败', () => charactersApi.patch(name, input));
    },

    async remove(name) {
      await mutate('删除角色失败', () => charactersApi.remove(name));
    },

    // ── Live2D ────────────────────────────────────────────────────────────

    async setPrimaryLive2d(characterName, live2dName) {
      await mutate('设置主要模型失败', () => charactersApi.setPrimaryLive2d(characterName, live2dName));
    },

    async patchLive2d(characterName, live2dName, input) {
      await mutate('保存模型配置失败', () => charactersApi.patchLive2d(characterName, live2dName, input));
    },

    async reloadLive2dConfig(characterName, live2dName) {
      await mutate('重新加载配置失败', () => charactersApi.reloadLive2dConfig(characterName, live2dName));
    },

    async deleteLive2d(characterName, live2dName) {
      await mutate('删除模型失败', () => charactersApi.deleteLive2d(characterName, live2dName));
    },

    // ── 插图 ──────────────────────────────────────────────────────────────

    async setPrimaryIllustration(characterName, illustrationName) {
      await mutate('设置主要插图失败', () => charactersApi.setPrimaryIllustration(characterName, illustrationName));
    },

    async importIllustration(characterName, input) {
      await mutate('导入插图失败', () => charactersApi.importIllustration(characterName, input));
    },

    async patchIllustration(characterName, illustrationName, input) {
      await mutate('保存插图配置失败', () =>
        charactersApi.patchIllustration(characterName, illustrationName, input));
    },

    async deleteIllustration(characterName, illustrationName) {
      await mutate('删除插图失败', () => charactersApi.deleteIllustration(characterName, illustrationName));
    },

    // ── 参考音频 ──────────────────────────────────────────────────────────

    async setPrimaryVoice(characterName, voiceName) {
      await mutate('设置主要参考音频失败', () => charactersApi.setPrimaryVoice(characterName, voiceName));
    },

    async importVoice(characterName, input) {
      await mutate('导入参考音频失败', () => charactersApi.importVoice(characterName, input));
    },

    async patchVoice(characterName, voiceName, input) {
      await mutate('保存参考音频失败', () => charactersApi.patchVoice(characterName, voiceName, input));
    },

    async deleteVoice(characterName, voiceName) {
      await mutate('删除参考音频失败', () => charactersApi.deleteVoice(characterName, voiceName));
    },
  };
});

export function handleCharacterSystemEvent(event: AppEvent): void {
  if (event.type === 'character_switched') {
    // 旧角色的情绪语义名不能补发给新角色。
    useLiveTurns.getState().clearEmotions();
    void useCharacterStore.getState().load();
  } else if (event.type === 'character_resources_changed') {
    void useCharacterStore.getState().load();
  }
}

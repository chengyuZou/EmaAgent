// 角色一族：安装内置资源并构造 CharacterStore 与 StageEngine。
import {
  CharacterStore,
  characterStageVocabulary,
  installBuiltinCharacterResources,
} from '@ema-agent/characters';
import { StageEngine } from '@ema-agent/stage';
import type { Database } from '@ema-agent/storage';
import { bundledCharactersDir, charactersDir } from '../platform/paths.js';

export interface CharactersComposition {
  readonly store: CharacterStore;
  /** 情绪与动作词汇跟随当前角色；角色切换后的替换与事件广播由总装配点接线。 */
  readonly stage: StageEngine;
}

/** 角色是 Prompt、Live2D、舞台表现与 TTS 的全局基础，种子不变量失败时禁止发布 ready。 */
export function openCharacters(
  profileDb: Database,
): CharactersComposition {
  installBuiltinCharacterResources(bundledCharactersDir(), charactersDir());
  const store = new CharacterStore(profileDb, charactersDir());
  store.ensureSeed();
  const current = store.current();
  const vocabulary = characterStageVocabulary(store.inspectStagePresentation(current.name));
  const stage = new StageEngine({
    emotions: vocabulary.emotions,
    motions: vocabulary.motions,
  });
  return { store, stage };
}

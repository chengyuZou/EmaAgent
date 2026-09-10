// 角色一族：构造 CharacterStore 与 StageEngine，并在首次 Profile 启动时写入内置角色行。
import { CharacterStore, characterStageVocabulary } from '@ema-agent/characters';
import { StageEngine } from '@ema-agent/stage';
import type { Database } from '@ema-agent/storage';
import { charactersDir } from '../platform/paths.js';

export interface CharactersComposition {
  readonly store: CharacterStore;
  /** 情绪与动作词汇跟随当前角色；角色切换后的替换与事件广播由总装配点接线。 */
  readonly stage: StageEngine;
}

/** 角色是 Prompt、Live2D、舞台表现与 TTS 的全局基础，种子不变量失败时禁止发布 ready。 */
export function openCharacters(
  profileDb: Database,
  initializeBuiltinCharacters: boolean,
): CharactersComposition {
  const store = new CharacterStore(profileDb, charactersDir());
  if (initializeBuiltinCharacters) {
    store.initializeBuiltinCharacters();
  }
  const current = store.current();
  const vocabulary = characterStageVocabulary(store.inspectStagePresentation(current.name));
  const stage = new StageEngine({
    emotions: vocabulary.emotions,
    motions: vocabulary.motions,
  });
  return { store, stage };
}

import { CharacterStore, characterStageVocabulary } from '@ema-agent/characters';
import { StageEngine } from '@ema-agent/stage';
import type { Database } from '@ema-agent/storage';
import { charactersDir } from '../platform/paths.js';

export interface CharactersComposition {
  readonly store: CharacterStore;
  /** 情绪与动作词汇跟随当前角色;角色切换后的替换与事件广播由总装配点接线. */
  readonly stage: StageEngine;
}

/** 启动前必须能读取当前角色及其演出词汇, 否则不开始接收请求. */
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

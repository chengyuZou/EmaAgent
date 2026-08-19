// 角色一族：内置角色资源幂等安装、CharacterCardStore 与 EmotionEngine。
import {
  CharacterCardStore,
  installBuiltinCharacterResources,
} from '@ema-agent/characters';
import { EmotionEngine } from '@ema-agent/emotion';
import type { Database } from '@ema-agent/storage';
import { bundledCharactersDir, charactersDir } from '../platform/paths.js';

export interface CharactersComposition {
  readonly cards: CharacterCardStore;
  /** 情绪词汇跟随当前角色；换卡时的 vocabulary 替换与事件广播由 composition/index 接线。 */
  readonly emotion: EmotionEngine;
}

/** 角色是 Prompt、Live2D、Emotion 与 TTS 的全局基础，种子不变量失败时禁止发布 ready。 */
export function openCharacters(profileDb: Database): CharactersComposition {
  installBuiltinCharacterResources(bundledCharactersDir(), charactersDir());
  const cards = new CharacterCardStore({
    db: profileDb,
    charactersRoot: charactersDir(),
  });
  cards.ensureSeed();
  const emotion = new EmotionEngine({
    vocabulary: [...cards.current().emotionVocabulary],
  });
  return { cards, emotion };
}

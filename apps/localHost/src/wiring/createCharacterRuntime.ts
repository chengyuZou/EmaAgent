// 幂等补齐内置角色卡及其表现资源，并用当前角色创建 EmotionEngine。

import { CharacterCardStore } from '@ema-agent/characters';
import { EmotionEngine } from '@ema-agent/emotion';
import type { Database } from '@ema-agent/storage';

export function createCharacterRuntime(profileDb: Database): {
  readonly card: CharacterCardStore;
  readonly emotion: EmotionEngine;
} {
  const card = new CharacterCardStore({ db: profileDb });
  card.ensureSeed();

  const emotion = new EmotionEngine({
    vocabulary: [...card.current().emotionVocabulary],
  });

  return { card, emotion };
}

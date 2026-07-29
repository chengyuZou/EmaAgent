// 按外键顺序补齐内置 Live2D 模型与角色卡，并用当前角色创建 EmotionEngine。

import {
  BUILTIN_CARDS,
  CharacterCardStore,
  EMA_CARD_ID,
  EMA_CARD_INPUT,
} from '@ema-agent/characters';
import { EmotionEngine } from '@ema-agent/emotion';
import { Live2DModelsRepo, type Database } from '@ema-agent/storage';

export function createCharacterRuntime(profileDb: Database): {
  readonly card: CharacterCardStore;
  readonly emotion: EmotionEngine;
} {
  ensureBuiltinLive2dModels(profileDb);

  const card = new CharacterCardStore({ db: profileDb });
  card.ensureSeed();

  const emotion = new EmotionEngine({
    vocabulary: [...card.current().emotionVocabulary],
  });

  return { card, emotion };
}

function ensureBuiltinLive2dModels(profileDb: Database): void {
  const live2dModels = new Live2DModelsRepo(profileDb.sqlite);

  for (const builtinCard of BUILTIN_CARDS) {
    if (!builtinCard.live2dModelId) continue;
    if (live2dModels.findById(builtinCard.live2dModelId)) continue;

    const cardId = builtinCard === EMA_CARD_INPUT
      ? EMA_CARD_ID
      : builtinCard.name;
    const now = Date.now();

    // 角色卡的 live2d_model_id 有外键，模型种子必须先于角色卡写入。
    live2dModels.insert({
      id: builtinCard.live2dModelId,
      name: builtinCard.name,
      format: 'live2d',
      storage_path: `cards/${cardId}/live2d/${builtinCard.live2dModelId}.model3.json`,
      params_json: '{}',
      is_builtin: 1,
      created_at: now,
      updated_at: now,
    });
  }
}

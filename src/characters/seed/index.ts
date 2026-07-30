// 汇总内置角色的角色卡与表现资源，供 LocalHost 启动时幂等注册。

/**
 * 内置角色卡种子。
 *
 * 每个内置角色一个文件。新增内置角色：
 *   1. 在这里建 `<id>-seed.ts`，导出一个 `CharacterCardInput`
 *   2. 把角色资源放进 `apps/desktop/public/cards/<id>/`
 *      （live2d/ + voiceRefs/ + live2d/runtime-config.json）
 *   3. 把种子 push 进下面的 BUILTIN_CARDS
 *
 * sidecar 启动时自动注册 BUILTIN_CARDS 里每条（幂等--已在 DB 的跳过）。
 * 没有死代码：新角色就是数据 + 一次 push，无需改接线。
 */
import type { CharacterCardInput } from '../types.js';
import type { CharacterLive2dVariantInput } from '../live2d/types.js';
import type { CharacterPortraitInput } from '../portraits/types.js';
import type { CharacterVoiceReferenceInput } from '../voiceReferences/types.js';
import {
  EMA_CARD_INPUT,
  EMA_CARD_ID,
  EMA_LIVE2D_VARIANTS,
  EMA_VOICE_REFERENCES,
} from './ema-seed.js';

export {
  EMA_CARD_INPUT,
  EMA_CARD_ID,
  EMA_LIVE2D_VARIANTS,
  EMA_VOICE_REFERENCES,
};

export interface BuiltinCharacterSeed {
  id: string;
  card: CharacterCardInput;
  live2dVariants: readonly CharacterLive2dVariantInput[];
  portraits: readonly CharacterPortraitInput[];
  voiceReferences: readonly CharacterVoiceReferenceInput[];
}

/**
 * 所有内置角色卡。启动 seeder 遍历此列表，逐条 upsert 进
 * character_cards 与三类显式角色资源表。
 */
export const BUILTIN_CARDS: readonly BuiltinCharacterSeed[] = [
  {
    id: EMA_CARD_ID,
    card: EMA_CARD_INPUT,
    live2dVariants: EMA_LIVE2D_VARIANTS,
    portraits: [],
    voiceReferences: EMA_VOICE_REFERENCES,
  },
  // 未来的内置角色放这里--push 种子即可。
];

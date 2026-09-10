// 汇总首次初始化时写入数据库的内置角色卡与表现资源行。

import type { CharacterInput } from '../types.js';
import type { CharacterLive2dModelInput } from '../live2d/types.js';
import type { CharacterIllustrationInput } from '../illustration/types.js';
import type { CharacterVoiceSampleInput } from '../voice/types.js';
import {
  EMA_CHARACTER_NAME,
  EMA_CHARACTER_INPUT,
  EMA_LIVE2D_MODELS,
  EMA_VOICE_SAMPLES,
} from './ema-seed.js';

export {
  EMA_CHARACTER_NAME,
  EMA_CHARACTER_INPUT,
  EMA_LIVE2D_MODELS,
  EMA_VOICE_SAMPLES,
};

export interface BuiltinCharacterSeed {
  card: CharacterInput;
  stageKind: 'live2d' | 'illustration' | 'blank';
  live2dModels: readonly CharacterLive2dModelInput[];
  illustrations: readonly CharacterIllustrationInput[];
  voiceSamples: readonly CharacterVoiceSampleInput[];
}

/** 所有内置角色。物理资源由 Desktop Host 在 Server 启动前铺入同名角色目录。 */
export const BUILTIN_CHARACTERS: readonly BuiltinCharacterSeed[] = [
  {
    card: EMA_CHARACTER_INPUT,
    stageKind: 'live2d',
    live2dModels: EMA_LIVE2D_MODELS,
    illustrations: [],
    voiceSamples: EMA_VOICE_SAMPLES,
  },
];

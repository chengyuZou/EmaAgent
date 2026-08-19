// 汇总内置角色的角色卡与表现资源，并在启动时安装到 Home 目录。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 内置角色卡种子。
 *
 * 每个内置角色一个文件。新增内置角色：
 *   1. 在这里建 `<id>-seed.ts`，导出一个 `CharacterInput`
 *   2. 把角色资源放进打包资源目录。开发期临时从
 *      `apps/desktop/public/cards/<id>/` 安装，运行时始终只读 Home 目录。
 *   3. 把种子 push 进下面的 BUILTIN_CARDS
 *
 * 本地后端启动时自动注册 BUILTIN_CARDS 里每条（幂等--已在 DB 的跳过）。
 * 没有死代码：新角色就是数据 + 一次 push，无需改接线。
 */
import type { CharacterInput } from '../types.js';
import type { CharacterLive2dModelInput } from '../live2d/types.js';
import type { CharacterIllustrationInput } from '../illustration/types.js';
import type { CharacterVoiceSampleInput } from '../voice/types.js';
import {
  EMA_CARD_INPUT,
  EMA_CARD_ID,
  EMA_LIVE2D_MODELS,
  EMA_VOICE_SAMPLES,
} from './ema-seed.js';

export {
  EMA_CARD_INPUT,
  EMA_CARD_ID,
  EMA_LIVE2D_MODELS,
  EMA_VOICE_SAMPLES,
};

export interface BuiltinCharacterSeed {
  id: string;
  card: CharacterInput;
  live2dModels: readonly CharacterLive2dModelInput[];
  illustrations: readonly CharacterIllustrationInput[];
  voiceSamples: readonly CharacterVoiceSampleInput[];
}

/**
 * 所有内置角色。启动 seeder 遍历此列表，逐条 upsert 进
 * characters 与三类角色资源表。
 */
export const BUILTIN_CARDS: readonly BuiltinCharacterSeed[] = [
  {
    id: EMA_CARD_ID,
    card: EMA_CARD_INPUT,
    live2dModels: EMA_LIVE2D_MODELS,
    illustrations: [],
    voiceSamples: EMA_VOICE_SAMPLES,
  },
  // 未来的内置角色放这里--push 种子即可。
];

/**
 * 开发期 sourceRoot 指向 `apps/desktop/public/cards`；正式包只替换这个来源。
 * 复制完成后，Character 运行时不再读取 sourceRoot。
 */
export function installBuiltinCharacterResources(
  sourceRoot: string,
  charactersRoot: string,
): void {
  const emaSource = path.join(sourceRoot, EMA_CARD_ID);
  if (!fs.existsSync(emaSource)) return;

  const live2dSource = path.join(emaSource, 'live2d');
  const live2dTarget = path.join(
    charactersRoot,
    EMA_CARD_ID,
    'live2d',
    EMA_LIVE2D_MODELS[0]!.directoryName,
  );
  if (fs.existsSync(live2dSource) && !fs.existsSync(live2dTarget)) {
    fs.mkdirSync(path.dirname(live2dTarget), { recursive: true });
    fs.cpSync(live2dSource, live2dTarget, { recursive: true });
  }

  const voiceSource = path.join(emaSource, 'voice', 'ra_ema001.mp3');
  const voiceTarget = path.join(
    charactersRoot,
    EMA_CARD_ID,
    'voice',
    EMA_VOICE_SAMPLES[0]!.fileName,
  );
  if (fs.existsSync(voiceSource) && !fs.existsSync(voiceTarget)) {
    fs.mkdirSync(path.dirname(voiceTarget), { recursive: true });
    fs.copyFileSync(voiceSource, voiceTarget, fs.constants.COPYFILE_EXCL);
  }
}

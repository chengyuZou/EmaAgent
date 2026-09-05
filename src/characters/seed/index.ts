// 汇总内置角色的角色卡与表现资源，并在启动时安装到 Home 目录。

import fs from 'node:fs';
import path from 'node:path';

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

/**
 * 所有内置角色。启动 seeder 遍历此列表，逐条幂等落库；资源文件按下面的
 * installBuiltinCharacterResources 复制。新角色 = 一个 <id>-seed.ts + 这里一次 push。
 */
export const BUILTIN_CHARACTERS: readonly BuiltinCharacterSeed[] = [
  {
    card: EMA_CHARACTER_INPUT,
    stageKind: 'live2d',
    live2dModels: EMA_LIVE2D_MODELS,
    illustrations: [],
    voiceSamples: EMA_VOICE_SAMPLES,
  },
];

/**
 * 开发期 sourceRoot 指向 `apps/desktop/src-tauri/resources/characters`；正式包只替换这个来源。
 * 逐角色按种子清单安装：每个模型的包目录按 directoryName 从 source 同名位置复制
 * （source/live2d/<directoryName> → target/live2d/<directoryName>），立绘与参考音频按
 * fileName 逐个复制。目标已存在即跳过，幂等。
 * 复制完成后，Character 运行时不再读取 sourceRoot。
 */
export function installBuiltinCharacterResources(
  sourceRoot: string,
  charactersRoot: string,
): void {
  for (const seed of BUILTIN_CHARACTERS) {
    const characterSource = path.join(sourceRoot, 'ema');
    if (!fs.existsSync(characterSource)) continue;
    const characterTarget = path.join(charactersRoot, seed.card.name);

    for (const model of seed.live2dModels) {
      const source = path.join(characterSource, 'live2d', model.name);
      const target = path.join(characterTarget, 'live2d', model.name);
      if (fs.existsSync(source) && !fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(source, target, { recursive: true });
      }
    }
    for (const illustration of seed.illustrations) {
      copyFileOnce(
        path.join(characterSource, 'illustration', illustration.name),
        path.join(characterTarget, 'illustration', illustration.name),
      );
    }
    for (const sample of seed.voiceSamples) {
      copyFileOnce(
        path.join(characterSource, 'voice', sample.name),
        path.join(characterTarget, 'voice', sample.name),
      );
    }
  }
}

function copyFileOnce(source: string, target: string): void {
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

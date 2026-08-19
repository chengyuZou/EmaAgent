// 定义角色 Prompt 与三类资源的用户可调上限，并在每次角色操作前读取当前值。

import type { SettingGroup, SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export const CHARACTER_PROMPT_LIMITS_GROUP = 'characters.promptLimits';

export const characterPromptMaxBlocksSetting = defineSetting<number>({
  key: 'characters.prompt.maxBlocks',
  apply: 'immediate',
  defaultValue: 32,
  schema: z.number().int().min(1).max(128),
  group: CHARACTER_PROMPT_LIMITS_GROUP,
});

export const characterPromptMaxBlockNameCharsSetting = defineSetting<number>({
  key: 'characters.prompt.maxBlockNameChars',
  apply: 'immediate',
  defaultValue: 80,
  schema: z.number().int().min(1).max(200),
  group: CHARACTER_PROMPT_LIMITS_GROUP,
});

export const characterPromptMaxBlockCharsSetting = defineSetting<number>({
  key: 'characters.prompt.maxBlockChars',
  apply: 'immediate',
  defaultValue: 16_000,
  schema: z.number().int().min(1_000).max(64_000),
  group: CHARACTER_PROMPT_LIMITS_GROUP,
});

export const characterPromptMaxTotalCharsSetting = defineSetting<number>({
  key: 'characters.prompt.maxTotalChars',
  apply: 'immediate',
  defaultValue: 64_000,
  schema: z.number().int().min(1_000).max(256_000),
  group: CHARACTER_PROMPT_LIMITS_GROUP,
});

export const characterLive2dMaxRuntimeConfigBytesSetting = defineSetting<number>({
  key: 'characters.live2d.maxRuntimeConfigBytes',
  apply: 'immediate',
  defaultValue: 1024 * 1024,
  schema: z.number().int().min(1024).max(16 * 1024 * 1024),
});

export const characterLive2dMaxZipEntriesSetting = defineSetting<number>({
  key: 'characters.live2d.maxZipEntries',
  apply: 'immediate',
  defaultValue: 500,
  schema: z.number().int().min(10).max(10_000),
});

export const characterLive2dMaxZipTotalBytesSetting = defineSetting<number>({
  key: 'characters.live2d.maxZipTotalBytes',
  apply: 'immediate',
  defaultValue: 200 * 1024 * 1024,
  schema: z.number().int().min(10 * 1024 * 1024).max(2 * 1024 * 1024 * 1024),
});

export const characterIllustrationMaxBytesSetting = defineSetting<number>({
  key: 'characters.illustration.maxBytes',
  apply: 'immediate',
  defaultValue: 20 * 1024 * 1024,
  schema: z.number().int().min(1024 * 1024).max(256 * 1024 * 1024),
});

export const characterVoiceMaxBytesSetting = defineSetting<number>({
  key: 'characters.voice.maxBytes',
  apply: 'immediate',
  defaultValue: 25 * 1024 * 1024,
  schema: z.number().int().min(1024 * 1024).max(256 * 1024 * 1024),
});

export const characterVoiceMaxDurationMsSetting = defineSetting<number>({
  key: 'characters.voice.maxDurationMs',
  apply: 'immediate',
  defaultValue: 10 * 60 * 1_000,
  schema: z.number().int().min(1_000).max(60 * 60 * 1_000),
});

export const CHARACTER_SETTING_DEFINITIONS = [
  characterPromptMaxBlocksSetting,
  characterPromptMaxBlockNameCharsSetting,
  characterPromptMaxBlockCharsSetting,
  characterPromptMaxTotalCharsSetting,
  characterLive2dMaxRuntimeConfigBytesSetting,
  characterLive2dMaxZipEntriesSetting,
  characterLive2dMaxZipTotalBytesSetting,
  characterIllustrationMaxBytesSetting,
  characterVoiceMaxBytesSetting,
  characterVoiceMaxDurationMsSetting,
] as const;

export const characterPromptLimitsGroup: SettingGroup = {
  id: CHARACTER_PROMPT_LIMITS_GROUP,
  definitions: [
    characterPromptMaxBlocksSetting,
    characterPromptMaxBlockNameCharsSetting,
    characterPromptMaxBlockCharsSetting,
    characterPromptMaxTotalCharsSetting,
  ],
  schema: z.object({
    'characters.prompt.maxBlocks': z.number(),
    'characters.prompt.maxBlockNameChars': z.number(),
    'characters.prompt.maxBlockChars': z.number(),
    'characters.prompt.maxTotalChars': z.number(),
  }).refine(
    values => values['characters.prompt.maxBlockChars']
      <= values['characters.prompt.maxTotalChars'],
    { message: '单个 Prompt Block 字符上限不能大于角色 Prompt 总字符上限' },
  ),
};

export interface CharacterSettings {
  readonly prompt: {
    readonly maxBlocks: number;
    readonly maxBlockNameChars: number;
    readonly maxBlockChars: number;
    readonly maxTotalChars: number;
  };
  readonly live2d: {
    readonly maxRuntimeConfigBytes: number;
    readonly maxZipEntries: number;
    readonly maxZipTotalBytes: number;
  };
  readonly illustration: {
    readonly maxBytes: number;
  };
  readonly voice: {
    readonly maxBytes: number;
    readonly maxDurationMs: number;
  };
}

export function readCharacterSettings(store: SettingsStore): CharacterSettings {
  return {
    prompt: {
      maxBlocks: store.get(characterPromptMaxBlocksSetting),
      maxBlockNameChars: store.get(characterPromptMaxBlockNameCharsSetting),
      maxBlockChars: store.get(characterPromptMaxBlockCharsSetting),
      maxTotalChars: store.get(characterPromptMaxTotalCharsSetting),
    },
    live2d: {
      maxRuntimeConfigBytes: store.get(characterLive2dMaxRuntimeConfigBytesSetting),
      maxZipEntries: store.get(characterLive2dMaxZipEntriesSetting),
      maxZipTotalBytes: store.get(characterLive2dMaxZipTotalBytesSetting),
    },
    illustration: {
      maxBytes: store.get(characterIllustrationMaxBytesSetting),
    },
    voice: {
      maxBytes: store.get(characterVoiceMaxBytesSetting),
      maxDurationMs: store.get(characterVoiceMaxDurationMsSetting),
    },
  };
}

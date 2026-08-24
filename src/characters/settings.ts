// 定义三类资源的用户可调上限，并在每次角色操作前读取当前值。

import type { SettingGroup, SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export const characterLive2dMaxRuntimeConfigBytesSetting = defineSetting<number>({
  key: 'characters.live2d.maxRuntimeConfigBytes',
  label: 'Live2D 配置体积上限',
  description: 'Live2D 运行时配置字节上限。',
  apply: 'immediate',
  defaultValue: 1024 * 1024,
  schema: z.number().int().min(1024).max(16 * 1024 * 1024),
});

export const characterLive2dMaxZipEntriesSetting = defineSetting<number>({
  key: 'characters.live2d.maxZipEntries',
  label: 'Live2D ZIP 条目上限',
  description: 'Live2D ZIP 条目数上限。',
  apply: 'immediate',
  defaultValue: 500,
  schema: z.number().int().min(10).max(10_000),
});

export const characterLive2dMaxZipTotalBytesSetting = defineSetting<number>({
  key: 'characters.live2d.maxZipTotalBytes',
  label: 'Live2D ZIP 体积上限',
  description: 'Live2D ZIP 解压总字节上限。',
  apply: 'immediate',
  defaultValue: 200 * 1024 * 1024,
  schema: z.number().int().min(10 * 1024 * 1024).max(2 * 1024 * 1024 * 1024),
});

export const characterIllustrationMaxBytesSetting = defineSetting<number>({
  key: 'characters.illustration.maxBytes',
  label: '插画文件体积上限',
  description: '角色插画文件字节上限。',
  apply: 'immediate',
  defaultValue: 20 * 1024 * 1024,
  schema: z.number().int().min(1024 * 1024).max(256 * 1024 * 1024),
});

export const characterVoiceMaxBytesSetting = defineSetting<number>({
  key: 'characters.voice.maxBytes',
  label: '语音文件体积上限',
  description: '角色语音文件字节上限。',
  apply: 'immediate',
  defaultValue: 25 * 1024 * 1024,
  schema: z.number().int().min(1024 * 1024).max(256 * 1024 * 1024),
});

export const characterVoiceMaxDurationMsSetting = defineSetting<number>({
  key: 'characters.voice.maxDurationMs',
  label: '语音时长上限',
  description: '角色语音最大时长（毫秒）。',
  apply: 'immediate',
  defaultValue: 10 * 60 * 1_000,
  schema: z.number().int().min(1_000).max(60 * 60 * 1_000),
});

export const CHARACTER_SETTING_DEFINITIONS = [
  characterLive2dMaxRuntimeConfigBytesSetting,
  characterLive2dMaxZipEntriesSetting,
  characterLive2dMaxZipTotalBytesSetting,
  characterIllustrationMaxBytesSetting,
  characterVoiceMaxBytesSetting,
  characterVoiceMaxDurationMsSetting,
] as const;

export interface CharacterSettings {
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

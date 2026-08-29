// 参考音频的用户可调上限，每次角色操作前读取当前值。

import type { SettingGroup, SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

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
  characterVoiceMaxBytesSetting,
  characterVoiceMaxDurationMsSetting,
] as const;

export interface CharacterSettings {
    readonly characterVoiceMaxBytes: number;
    readonly characterVoiceMaxDurationMs: number;
}

export function readCharacterSettings(store: SettingsStore): CharacterSettings {
  return {
    characterVoiceMaxBytes: store.get(characterVoiceMaxBytesSetting),
    characterVoiceMaxDurationMs: store.get(characterVoiceMaxDurationMsSetting),
  };
}

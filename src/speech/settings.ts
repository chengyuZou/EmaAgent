// 定义逐句音频片段库的文件数量与磁盘字节上限。

import type { SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export interface SpeechSegmentLibraryLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

export const speechSegmentMaxFilesSetting = defineSetting<number>({
  key: 'speech.segments.maxFiles',
  description: '逐句音频片段库的最大文件数量。',
  apply: 'nextOperation',
  defaultValue: 20_000,
  schema: z.number().int().min(100).max(100_000),
});

export const speechSegmentMaxBytesSetting = defineSetting<number>({
  key: 'speech.segments.maxBytes',
  description: '逐句音频片段库的磁盘字节上限。',
  apply: 'nextOperation',
  defaultValue: 1024 * 1024 * 1024,
  schema: z.number().int().min(64 * 1024 * 1024).max(10 * 1024 * 1024 * 1024),
});

export function readSpeechSegmentLibraryLimits(
  settings: Pick<SettingsStore, 'get'>,
): SpeechSegmentLibraryLimits {
  return {
    maxFiles: settings.get(speechSegmentMaxFilesSetting),
    maxBytes: settings.get(speechSegmentMaxBytesSetting),
  };
}

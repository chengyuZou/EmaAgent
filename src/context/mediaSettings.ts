import { defineSetting } from '@ema-agent/settings/definition';
import type { SettingsStore } from '@ema-agent/settings';
import { z } from 'zod';

export const maxMediaItemsSetting = defineSetting({
  key: 'context.media.maxItems',
  apply: 'nextTurn',
  defaultValue: 100,
  schema: z.number().int().min(1).max(1000),
});

export const maxMediaMiBSetting = defineSetting({
  key: 'context.media.maxMiB',
  apply: 'nextTurn',
  defaultValue: 20,
  schema: z.number().int().min(1).max(128),
});

export const MEDIA_SETTINGS = [
  maxMediaItemsSetting,
  maxMediaMiBSetting,
] as const;

export interface MediaSettings {
  readonly maxItems: number;
  // 本次请求所有内联媒体的编码字节预算, 包括 base64 膨胀. 不代表供应商的完整 HTTP 上限.
  readonly maxBytes: number;
}

export function readMediaSettings(settings: SettingsStore): MediaSettings {
  return {
    maxItems: settings.get(maxMediaItemsSetting),
    maxBytes: settings.get(maxMediaMiBSetting) * 1024 * 1024,
  };
}

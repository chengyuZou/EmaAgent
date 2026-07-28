// 定义附件接收、图片规范化与派生缓存的用户可调安全范围。

import { defineSetting } from '@ema-agent/settings';

export interface AttachmentSettings {
  maxImagesPerTurn: number;
  maxFilesPerTurn: number;
  maxImageBytes: number;
  maxImageLongEdge: number;
  derivationCacheBytes: number;
}

export const DEFAULT_ATTACHMENT_SETTINGS: AttachmentSettings = {
  maxImagesPerTurn: 5,
  maxFilesPerTurn: 10,
  maxImageBytes: 20 * 1024 * 1024,
  maxImageLongEdge: 2_048,
  derivationCacheBytes: 512 * 1024 * 1024,
};

export const attachmentSetting = defineSetting<AttachmentSettings>({
  key: 'attachments.limits',
  kind: 'object',
  apply: 'nextTurn',
  defaultValue: DEFAULT_ATTACHMENT_SETTINGS,
  decode(value) {
    if (!isRecord(value)) return { ok: false };
    const merged = { ...DEFAULT_ATTACHMENT_SETTINGS, ...value };
    if (!integerInRange(merged.maxImagesPerTurn, 1, 10)) return { ok: false };
    if (!integerInRange(merged.maxFilesPerTurn, 1, 20)) return { ok: false };
    if (!integerInRange(merged.maxImageBytes, 1024 * 1024, 20 * 1024 * 1024)) return { ok: false };
    if (!integerInRange(merged.maxImageLongEdge, 512, 2_048)) return { ok: false };
    if (!integerInRange(merged.derivationCacheBytes, 64 * 1024 * 1024, 2 * 1024 * 1024 * 1024)) {
      return { ok: false };
    }
    return { ok: true, value: merged as AttachmentSettings };
  },
  encode: value => value,
});

function integerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

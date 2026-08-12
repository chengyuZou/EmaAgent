// 定义附件输入限额与 Vision 描述缓存预算的用户可调范围。

import { defineSetting } from '@ema-agent/settings';

export interface AttachmentInputSettings {
  readonly maxImagesPerTurn: number;
  readonly maxFilesPerTurn: number;
  readonly maxImageBytes: number;
}

export const DEFAULT_ATTACHMENT_INPUT_SETTINGS: AttachmentInputSettings = {
  maxImagesPerTurn: 10,
  maxFilesPerTurn: 10,
  maxImageBytes: 5 * 1024 * 1024,
};

export const attachmentInputSetting = defineSetting<AttachmentInputSettings>({
  key: 'attachments.input',
  kind: 'object',
  apply: 'nextTurn',
  defaultValue: DEFAULT_ATTACHMENT_INPUT_SETTINGS,
  decode(value) {
    if (!isRecord(value)) return { ok: false };
    const merged = { ...DEFAULT_ATTACHMENT_INPUT_SETTINGS, ...value };
    // 产品硬上限：图片 10 张 / 单图 5 MiB；设置只允许在硬上限以内调小。
    if (!integerInRange(merged.maxImagesPerTurn, 1, 10)) return { ok: false };
    if (!integerInRange(merged.maxFilesPerTurn, 1, 20)) return { ok: false };
    if (!integerInRange(merged.maxImageBytes, 1024 * 1024, 5 * 1024 * 1024)) return { ok: false };
    return {
      ok: true,
      value: {
        maxImagesPerTurn: merged.maxImagesPerTurn,
        maxFilesPerTurn: merged.maxFilesPerTurn,
        maxImageBytes: merged.maxImageBytes,
      },
    };
  },
});

export interface AttachmentCacheSettings {
  readonly maxBytes: number;
}

export const DEFAULT_ATTACHMENT_CACHE_SETTINGS: AttachmentCacheSettings = {
  // Vision 描述是纯文本（一条约 1 KB 量级），64 MiB 约等于六万条描述。
  maxBytes: 64 * 1024 * 1024,
};

export const attachmentCacheSetting = defineSetting<AttachmentCacheSettings>({
  key: 'attachments.cache',
  kind: 'object',
  apply: 'nextOperation',
  defaultValue: DEFAULT_ATTACHMENT_CACHE_SETTINGS,
  decode(value) {
    if (!isRecord(value)) return { ok: false };
    const merged = { ...DEFAULT_ATTACHMENT_CACHE_SETTINGS, ...value };
    if (!integerInRange(merged.maxBytes, 4 * 1024 * 1024, 1024 * 1024 * 1024)) {
      return { ok: false };
    }
    return { ok: true, value: { maxBytes: merged.maxBytes } };
  },
});

function integerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

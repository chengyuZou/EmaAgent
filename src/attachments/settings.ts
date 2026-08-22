// 定义附件输入限额与 Vision 描述缓存预算的用户可调范围。
// 拆细为一字段一 key;消费方仍要整块快照,由 read* 聚合函数提供。

import type { SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export interface AttachmentInputSettings {
  readonly maxImagesPerTurn: number;
  readonly maxFilesPerTurn: number;
  readonly maxImageBytes: number;
}

export const maxImagesPerTurnSetting = defineSetting<number>({
  key: 'attachments.input.maxImagesPerTurn',
  description: '每 Turn 图片数量上限（产品硬上限 10，设置只能在硬上限以内调小）。',
  apply: 'nextTurn',
  defaultValue: 10,
  // 产品硬上限：图片 10 张；设置只允许在硬上限以内调小。
  schema: z.number().int().min(1).max(10),
});

export const maxFilesPerTurnSetting = defineSetting<number>({
  key: 'attachments.input.maxFilesPerTurn',
  description: '每 Turn 附件文件数量上限。',
  apply: 'nextTurn',
  defaultValue: 10,
  schema: z.number().int().min(1).max(20),
});

export const maxImageBytesSetting = defineSetting<number>({
  key: 'attachments.input.maxImageBytes',
  description: '单张图片字节上限（产品硬上限 5 MiB，设置只能在硬上限以内调小）。',
  apply: 'nextTurn',
  defaultValue: 5 * 1024 * 1024,
  // 产品硬上限：单图 5 MiB；设置只允许在硬上限以内调小。
  schema: z.number().int().min(1024 * 1024).max(5 * 1024 * 1024),
});

export const DEFAULT_ATTACHMENT_INPUT_SETTINGS: AttachmentInputSettings = {
  maxImagesPerTurn: maxImagesPerTurnSetting.defaultValue,
  maxFilesPerTurn: maxFilesPerTurnSetting.defaultValue,
  maxImageBytes: maxImageBytesSetting.defaultValue,
};

export interface AttachmentCacheSettings {
  readonly maxBytes: number;
}

export const attachmentCacheMaxBytesSetting = defineSetting<number>({
  key: 'attachments.cache.maxBytes',
  description: 'Vision 描述缓存字节上限（一条约 1 KB，64 MiB ≈ 六万条描述）。',
  apply: 'nextOperation',
  // Vision 描述是纯文本（一条约 1 KB 量级），64 MiB 约等于六万条描述。
  defaultValue: 64 * 1024 * 1024,
  schema: z.number().int().min(4 * 1024 * 1024).max(1024 * 1024 * 1024),
});

export const DEFAULT_ATTACHMENT_CACHE_SETTINGS: AttachmentCacheSettings = {
  maxBytes: attachmentCacheMaxBytesSetting.defaultValue,
};

/** 聚合读取附件输入限额快照(坏值/缺失自动回落默认)。 */
export function readAttachmentInputSettings(
  store: SettingsStore,
): AttachmentInputSettings {
  return {
    maxImagesPerTurn: store.get(maxImagesPerTurnSetting),
    maxFilesPerTurn: store.get(maxFilesPerTurnSetting),
    maxImageBytes: store.get(maxImageBytesSetting),
  };
}

/** 聚合读取附件缓存预算快照。 */
export function readAttachmentCacheSettings(
  store: SettingsStore,
): AttachmentCacheSettings {
  return {
    maxBytes: store.get(attachmentCacheMaxBytesSetting),
  };
}

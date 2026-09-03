// 定义附件输入硬限制与 Vision 描述缓存的用户设置.

import type { SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export interface AttachmentCacheSettings {
  readonly maxBytes: number;
}

export const attachmentCacheMaxBytesSetting = defineSetting({
  key: 'attachments.cache.maxBytes',
  apply: 'nextOperation',
  // Vision 描述是纯文本（一条约 1 KB 量级），64 MiB 约等于六万条描述。
  defaultValue: 64 * 1024 * 1024,
  schema: z.number().int().min(4 * 1024 * 1024).max(1024 * 1024 * 1024),
});

export const DEFAULT_ATTACHMENT_CACHE_SETTINGS: AttachmentCacheSettings = {
  maxBytes: attachmentCacheMaxBytesSetting.defaultValue,
};

/** 聚合读取附件缓存预算快照。 */
export function readAttachmentCacheSettings(
  store: SettingsStore,
): AttachmentCacheSettings {
  return {
    maxBytes: store.get(attachmentCacheMaxBytesSetting),
  };
}

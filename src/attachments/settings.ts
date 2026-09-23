import type { SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export interface AttachmentCacheSettings {
  readonly maxBytes: number;
}

export const attachmentCacheMaxBytesSetting = defineSetting({
  key: 'attachments.cache.maxBytes',
  apply: 'nextOperation',
  defaultValue: 64 * 1024 * 1024,
  schema: z.number().int().min(4 * 1024 * 1024).max(1024 * 1024 * 1024),
});

export const DEFAULT_ATTACHMENT_CACHE_SETTINGS: AttachmentCacheSettings = {
  maxBytes: attachmentCacheMaxBytesSetting.defaultValue,
};

export function readAttachmentCacheSettings(
  store: SettingsStore,
): AttachmentCacheSettings {
  return {
    maxBytes: store.get(attachmentCacheMaxBytesSetting),
  };
}

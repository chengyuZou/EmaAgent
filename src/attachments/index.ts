// Attachments 包统一出口：只导出真实公共入口，内部实现不穿透。

export { AttachmentStore } from './attachmentStore.js';
export type { AttachmentStoreDeps } from './attachmentStore.js';
export {
  resolveAttachmentReferences,
} from './modelContent.js';
export type {
  DescribeAttachmentImage,
  ResolveAttachmentOptions,
} from './modelContent.js';
export { VisionDescriptionCache } from './visionDescriptionCache.js';
export type {
  VisionDescriptionProducer,
} from './visionDescriptionCache.js';
export { AttachmentCacheMaintenance } from './cacheMaintenance.js';
export type {
  AttachmentCacheMaintenanceOptions,
  AttachmentCacheMaintenanceReport,
} from './cacheMaintenance.js';
export { AttachmentLimitError, AttachmentPreparationError } from './errors.js';
export type { TurnAttachmentInput } from './protocol.js';
export type {
  Attachment,
  AttachmentSourceStatus,
  FileAttachment,
  ImageAttachment,
  InspectedAttachment,
} from './types.js';
export {
  DEFAULT_ATTACHMENT_CACHE_SETTINGS,
  DEFAULT_ATTACHMENT_INPUT_SETTINGS,
  attachmentCacheMaxBytesSetting,
  maxFilesPerTurnSetting,
  maxImageBytesSetting,
  maxImagesPerTurnSetting,
  readAttachmentCacheSettings,
  readAttachmentInputSettings,
} from './settings.js';
export type { AttachmentCacheSettings, AttachmentInputSettings } from './settings.js';

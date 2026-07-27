// 这是 Attachment 包的统一出口，外部代码从这里使用它的功能和类型。

export { AttachmentStore }                      from './store.js';
export type { AttachmentStorePort }             from './store.js';
export { FileAccessFacade } from './file-access.js';
export type { AuthorizedAttachmentInput } from './file-access.js';
export { resolveForPrompt }                     from './resolver.js';
export { normalizeAttachmentImage } from './derivations/imageNormalization.js';
export { AttachmentDerivationCache } from './derivations/cache.js';
export type {
  AttachmentDerivationCacheOptions,
  VisionDescriptionProducer,
} from './derivations/cache.js';
export { AttachmentCacheMaintenance } from './derivations/maintenance.js';
export type {
  AttachmentCacheMaintenanceOptions,
  AttachmentCacheMaintenanceReport,
} from './derivations/maintenance.js';
export { AttachmentNotFoundError, AttachmentFileError } from './errors.js';
export type {
  Attachment,
  AttachmentImageSource,
  AttachmentInput,
  AttachmentVisionTask,
  CachedVisionDescription,
  CachedVisionDescriptionRequest,
  InspectedAttachment,
  NormalizedAttachmentImage,
  ResolvedPrompt,
  TurnAttachment,
} from './types.js';

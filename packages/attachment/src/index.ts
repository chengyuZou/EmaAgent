// 这是 Attachment 包的统一出口，外部代码从这里使用它的功能和类型。

export { AttachmentStore }                      from './store.js';
export type { IAttachmentStore }                from './store.js';
export { resolveForPrompt }                     from './resolver.js';
export { AttachmentNotFoundError, AttachmentFileError } from './errors.js';
export type {
  Attachment,
  AttachmentInput,
  InspectedAttachment,
  ResolvedPrompt,
  TurnAttachment,
} from './types.js';

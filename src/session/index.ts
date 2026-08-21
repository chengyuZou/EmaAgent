export { SessionStore } from './store.js';
export { DEFAULT_SESSION_TITLE } from './store.js';
export type { SessionStoreDeps } from './store.js';
export { generateSessionTitle } from './sessionTitle.js';
export type { SessionTitleCompletion } from './sessionTitle.js';
export { SessionOwnershipError } from './errors.js';
export { parseMessageBlocksJson } from './message.js';
export type {
  Session,
  SessionListItem,
  Message,
  Project,
  ProjectFolder,
  ProjectGroup,
  CreateSessionInput,
  PatchSessionInput,
  AppendMessageInput,
  ListMessagesInput,
  SearchSessionsInput,
  SessionSearchHit,
  SearchSessionsOutput,
} from './types.js';

export type {
  AttachmentReferenceBlock,
  AssistantBlock,
  MessageBlocks,
  ToolResultBlock,
  UserBlock,
} from './message.js';
export type { MessageKind, MessageRole } from '@ema-agent/storage';

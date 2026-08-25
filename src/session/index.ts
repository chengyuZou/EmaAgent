export { SessionStore } from './store.js';
export { DEFAULT_SESSION_TITLE } from './store.js';
export type { SessionStoreDeps } from './store.js';
export { generateSessionTitle } from './sessionTitle.js';
export type { SessionTitleCompletion } from './sessionTitle.js';
export { SessionOwnershipError } from './errors.js';
export {
  ActiveSessionAlreadyRegisteredError,
  SessionBusyError,
} from './errors.js';
export { ActiveSessionRegistry } from './activeSessionRegistry.js';
export type {
  ActiveSessionExecution,
  ActiveSessionExecutionKind,
} from './activeSessionRegistry.js';
export { parseMessageBlocksJson, collectAttachmentReferenceIds } from './message.js';
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
  ExecutionProfile,
  NarrativePolicy,
  TurnStatus,
} from './types.js';

export type {
  AttachmentReferenceBlock,
  AssistantBlock,
  MessageBlocks,
  SkillReferenceBlock,
  ToolResultBlock,
  UserBlock,
} from './message.js';
export type { MessageKind, MessageRole } from '@ema-agent/storage';

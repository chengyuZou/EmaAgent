export { SessionStore } from './store.js';
export type { SessionStoreDeps } from './store.js';
export { SessionLifecycle } from './sessionLifecycle.js';
export type { SessionLifecycleDeps } from './sessionLifecycle.js';
export { SessionTitleGenerator } from './sessionTitleGenerator.js';
export type { SessionTitleCompletionPort } from './sessionTitleGenerator.js';
export { RunRegistry } from './run-registry.js';
export { SessionOwnershipError } from './errors.js';
export { parseMessageBlocksJson } from './message.js';
export type {
  SessionWire,
  SessionsListResult,
  SessionsGroupedResult,
  SessionSearchItem,
  SessionsSearchResult,
  ForkResult,
  TurnWire,
  MessageWire,
  SessionMessagesResult,
  TurnIndexItemWire,
  TurnIndexPageWire,
  SessionMessageWindowWire,
  SessionAttachmentFileStatus,
  SessionAttachmentWire,
  SessionAttachmentsResult,
  AudioEntryWire,
  SessionNoteEntryWire,
  SessionNoteWire,
  SessionDashboardWire,
} from './protocol.js';

export type {
  Session,
  Turn,
  Message,
  CreateSessionInput,
  PatchSessionInput,
  StartTurnInput,
  CompleteTurnInput,
  AppendMessageInput,
  ListSessionsInput,
  ListSessionsOutput,
  ListMessagesInput,
  ListTurnIndexInput,
  TurnIndexItem,
  TurnIndexPage,
  ListMessageWindowInput,
  MessageWindow,
  SearchSessionsInput,
  SessionSearchHit,
  SearchSessionsOutput,
  SessionOwnershipFacade,
  SessionOwnedEntity,
} from './types.js';

export type {
  AttachmentReferenceBlock,
  AssistantBlock,
  MessageBlocks,
  MessageContentPart,
  NarrativeContextBlocks,
  NarrativeTimelineRecall,
  ToolResultBlock,
  UserBlock,
} from './message.js';
export type { MessageKind, MessageRole } from '@ema-agent/storage';

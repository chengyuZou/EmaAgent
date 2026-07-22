export { SessionStore } from './store.js';
export type { SessionStoreDeps } from './store.js';
export { RunRegistry } from './run-registry.js';
export { BranchAncestorTable } from './branch-ancestor.js';
export { EulerTourRMQLCA } from './euler-rmq-lca.js';
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
  BranchNodeWire,
  TurnTreeNodeWire,
  BranchTreeWire,
  SessionAttachmentFileStatus,
  SessionAttachmentWire,
  SessionAttachmentsResult,
  ArtifactSummaryWire,
  AudioEntryWire,
  SessionNoteEntryWire,
  SessionNoteWire,
  SessionDashboardWire,
} from './protocol.js';

export type {
  Session,
  Turn,
  Message,
  Branch,
  BranchSibling,
  CreateSessionInput,
  StartTurnInput,
  CompleteTurnInput,
  AppendMessageInput,
  ForkMessageInput,
  SwitchBranchInput,
  ListSessionsInput,
  ListSessionsOutput,
  ListMessagesInput,
  SearchSessionsInput,
  SessionSearchHit,
  SearchSessionsOutput,
  SessionOwnershipFacade,
  SessionOwnedEntity,
} from './types.js';

export type {
  AssistantBlock,
  MessageBlocks,
  MessageContentPart,
  NarrativeContextBlocks,
  NarrativeTimelineRecall,
  ToolResultBlock,
  UserBlock,
} from './message.js';
export type { MessageKind, MessageRole } from '@ema-agent/storage';

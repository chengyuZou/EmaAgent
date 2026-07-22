// 定义 Session 模块跨 Core 与客户端传输的稳定 JSON 结构。
import type {
  MessageBlocks,
  MessageKind,
  MessageRole,
  TurnAttachment,
  TurnStatus,
} from '@ema-agent/contracts';
import type {
  ExecutionProfile,
  NarrativePolicy,
  TurnTriggerType,
} from '@ema-agent/turn';

export type SessionAttachmentFileStatus =
  | 'available'
  | 'modified'
  | 'missing'
  | 'inaccessible';

export interface SessionAttachmentWire {
  id: string;
  turnId: string;
  sessionId: string;
  name: string;
  mimeType: string;
  size: number;
  mtime: number;
  fileHandle: string | null;
  createdAt: number;
  fileStatus: SessionAttachmentFileStatus;
}

export interface SessionAttachmentsResult {
  attachments: SessionAttachmentWire[];
}

export interface ArtifactSummaryWire {
  id: string;
  type: string;
  title: string;
  contentLocation: 'inline' | 'file';
  byteSize: number;
  createdAt: number;
  appliedAt: number | null;
  rejectedAt: number | null;
}

export interface AudioEntryWire {
  turnId: string;
  mimeType: string;
  byteSize: number;
  durationMs: number | null;
  segmentCount: number;
  createdAt: number;
}

export interface SessionNoteEntryWire {
  timestamp: string;
  delta: string;
}

export interface SessionNoteWire {
  sessionId: string;
  entries: SessionNoteEntryWire[];
  tokensAtLastUpdate: number;
  updatedAt: number;
}

export interface SessionDashboardWire {
  sessionId: string;
  turnCount: number;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  modeCounts: { chat: number; narrative: number; agent: number };
  branchCount: number;
  artifactCount: number;
  artifactTotalBytes: number;
  artifacts: ArtifactSummaryWire[];
  audioTurnCount: number;
  audioTotalBytes: number;
  audioTotalDurationMs: number;
  audioEntries: AudioEntryWire[];
  attachmentCount: number;
  attachmentTotalBytes: number;
  notes: SessionNoteWire | null;
}

export interface SessionWire {
  id: string;
  title: string;
  workspaceRoot: string | null;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  archivedAt: number | null;
  pinned: boolean;
  pinnedAt: number | null;
  groupLabel: string | null;
  parentSessionId: string | null;
  runningTurnCount: number;
  /** 下一 Turn 默认采用的执行能力范围。 */
  executionProfile: ExecutionProfile;
  /** 下一 Turn 默认采用的剧情检索策略。 */
  narrativePolicy: NarrativePolicy;
  preferredProviderConfigId: string | null;
  preferredModelId: string | null;
  lastViewedAt: number | null;
  lastTurnStatus: TurnStatus | null;
  hasUnread: boolean;
}

export interface SessionsListResult {
  sessions: SessionWire[];
  nextCursor?: string;
}

export interface SessionsGroupedResult {
  pinned: SessionWire[];
  byGroup: Array<{ label: string; sessions: SessionWire[] }>;
  recent: SessionWire[];
  archived: SessionWire[];
}

export interface SessionSearchItem {
  session: SessionWire;
  matchKind: 'title' | 'message';
  snippet: string;
  messageId: string | null;
  messageAt: number | null;
}

export interface SessionsSearchResult {
  results: SessionSearchItem[];
}

export interface ForkResult {
  sessionId: string;
  messageCount: number;
  /** Fork 时来源 Session 的 active branch，平会话为 null。 */
  sourceBranchId: string | null;
}

export interface TurnWire {
  id: string;
  sessionId: string;
  triggerType: TurnTriggerType;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  status: TurnStatus;
  userInput: string;
  startedAt: number;
  completedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  iterations: number;
  usageInputTokens: number;
  usageOutputTokens: number;
}

export interface MessageWire {
  id: string;
  sessionId: string;
  turnId: string | null;
  role: MessageRole;
  kind: MessageKind;
  blocks: MessageBlocks;
  interrupted: boolean;
  attachments?: TurnAttachment[];
  createdAt: number;
}

export interface SessionMessagesResult {
  messages: MessageWire[];
  turns: TurnWire[];
}

export interface BranchNodeWire {
  branchId: string;
  parentBranchId: string | null;
  forkFromTurnId: string | null;
  forkUserInput: string;
  isActive: boolean;
  createdAt: number;
}

export interface TurnTreeNodeWire {
  id: string;
  branchId: string | null;
  startedAt: number;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  userInput: string;
  status: TurnStatus;
}

export interface BranchTreeWire {
  sessionActiveBranchId: string | null;
  branches: BranchNodeWire[];
  turns: TurnTreeNodeWire[];
}

// 定义 Session 模块跨 Core 与客户端传输的稳定 JSON 结构。

import type { MessageKind, MessageRole } from '@ema-agent/storage';
import type {
  ExecutionProfile,
  NarrativePolicy,
  TurnAttachment,
  TurnStatus,
  TurnTriggerType,
} from '@ema-agent/turn';
import type { MessageBlocks } from './message.js';

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
  turnCounts: { chat: number; work: number; narrativeAlways: number };
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
  forkedFromSessionId: string | null;
  forkedFromTurnId: string | null;
  /** 列表投影三字段：仅列表/搜索路径有真值。 */
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
  byProject: Array<{ workspaceRoot: string; sessions: SessionWire[] }>;
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
}

export interface TurnWire {
  id: string;
  sessionId: string;
  triggerType: TurnTriggerType;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  status: TurnStatus;
  providerConfigId: string | null;
  modelId: string | null;
  iterations: number;
  usageInputTokens: number;
  usageOutputTokens: number;
  createdAt: number;
  completedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
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

export interface TurnIndexItemWire {
  turnId: string;
  createdAt: number;
  completedAt: number | null;
  status: TurnStatus;
  triggerType: TurnTriggerType;
  executionProfile: ExecutionProfile;
  preview: string;
}

export interface TurnIndexPageWire {
  items: TurnIndexItemWire[];
  nextCursor?: string;
}

export interface SessionMessageWindowWire {
  anchorTurnId: string;
  turns: TurnWire[];
  messages: MessageWire[];
  hasOlder: boolean;
  hasNewer: boolean;
}

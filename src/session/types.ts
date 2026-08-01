import type { SessionId, TurnId, MessageId } from '@ema-agent/ids';
import type { MessageKind, MessageRole } from '@ema-agent/storage';
import type {
  ExecutionProfile,
  NarrativePolicy,
  TurnStatus,
  TurnTriggerType,
} from '@ema-agent/turn';
import type { MessageBlocks } from './message.js';

/** Session 聚合向其他模块提供的归属校验端口。 */
export interface SessionOwnershipFacade {
  assertTurnOwnership(sessionId: SessionId, turnId: TurnId): void;
  assertMessageOwnership(sessionId: SessionId, messageId: MessageId): void;
}

export type SessionOwnedEntity = 'message' | 'turn';

// 领域对象使用已经解析的 camelCase 字段。

export interface Session {
  id: SessionId;
  title: string;
  workspaceRoot:  string | null;
  createdAt: number;
  /** 行属性更新时间：标题、分组、置顶、Workspace 或执行偏好发生变化。 */
  updatedAt: number;
  /** 会话活动时间，用于“最近 Session”排序。 */
  lastActivityAt: number;
  archivedAt: number | null;
  pinned:        boolean;
  pinnedAt:      number | null;
  groupLabel:    string | null;
  parentSessionId: SessionId | null;
  runningTurnCount: number;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  /** 用户希望该 Session 下一轮默认使用的供应商配置；null 表示使用系统默认选择。 */
  preferredProviderConfigId: string | null;
  /** 用户希望该 Session 下一轮默认使用的模型；null 表示使用系统默认选择。 */
  preferredModelId: string | null;
  lastViewedAt:   number | null;
  lastTurnStatus: TurnStatus | null;
  hasUnread:      boolean;
}

export interface Turn {
  id:           TurnId;
  sessionId:    SessionId;
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

export interface Message {
  id: MessageId;
  sessionId: SessionId;
  turnId: TurnId | null;
  role: MessageRole;
  kind: MessageKind;
  /**
   * 已解析的内容块：System 是普通文本，User 可包含媒体或 Tool Result，
   * Assistant 保留 text、thinking 与 tool_use 的原始顺序。
   */
  blocks: MessageBlocks;
  interrupted: boolean;
  createdAt: number;
}

// SessionStore 的输入输出契约。

export interface CreateSessionInput {
  title?: string;
  workspaceRoot?:  string | null;
  parentSessionId?: SessionId;
}

/** 用户可在 Session 存续期间修改的偏好；undefined 表示保持原值。 */
export interface PatchSessionInput {
  title?: string;
  pinned?: boolean;
  groupLabel?: string | null;
  workspaceRoot?: string | null;
  executionProfile?: ExecutionProfile;
  narrativePolicy?: NarrativePolicy;
  preferredModel?: {
    providerConfigId: string;
    modelId: string;
  } | null;
}

export interface StartTurnInput {
  /** 内部恢复流程可预留稳定身份；公开请求始终由 SessionStore 生成。 */
  turnId?: TurnId;
  sessionId: SessionId;
  triggerType: TurnTriggerType;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  userInput: string;
}

export interface CompleteTurnInput {
  usageInputTokens?: number;
  usageOutputTokens?: number;
  iterations?: number;
}

export interface AppendMessageInput {
  turnId: TurnId;
  sessionId: SessionId;
  role: MessageRole;
  kind?: MessageKind;
  blocks: MessageBlocks;
  interrupted?: boolean;
}

export interface ListSessionsInput {
  /** 单页最多返回的 Session 数量。 */
  limit?: number;
  /**
   * 上一页返回的不透明 V1 cursor。调用方只能原样回传，不能解析或构造。
   * 服务端使用 `(pinned DESC, last_activity_at DESC, id DESC)` 做稳定分页。
   */
  cursor?: string;
}

export interface ListSessionsOutput {
  sessions: Session[];
  /** 仍有下一页时返回，调用方应原样作为下一次的 cursor。 */
  nextCursor?: string;
}

export interface ListMessagesInput {
  /** 加载早于该时间戳的消息，供 UI 热历史分页。 */
  before?: number;
  limit?: number;
}

export interface ListTurnIndexInput {
  /** 上一页返回的不透明游标，只能原样回传。 */
  cursor?: string;
  limit?: number;
}

export interface TurnIndexItem {
  turnId: TurnId;
  startedAt: number;
  completedAt: number | null;
  status: TurnStatus;
  triggerType: TurnTriggerType;
  executionProfile: ExecutionProfile;
  preview: string;
}

export interface TurnIndexPage {
  items: TurnIndexItem[];
  nextCursor?: string;
}

export interface ListMessageWindowInput {
  anchorTurnId: TurnId;
  /** 锚点之前需要读取的较旧 Turn 数量。 */
  beforeTurns?: number;
  /** 锚点之后需要读取的较新 Turn 数量。 */
  afterTurns?: number;
}

export interface MessageWindow {
  anchorTurnId: TurnId;
  turns: Turn[];
  messages: Message[];
  hasOlder: boolean;
  hasNewer: boolean;
}

export interface SearchSessionsInput {
  query: string;
  limit?: number;
}

export interface SessionSearchHit {
  session:   Session;
  matchKind: 'title' | 'message';
  snippet:   string;
  messageId: MessageId | null;
  messageAt: number | null;
}

export interface SearchSessionsOutput {
  results: SessionSearchHit[];
}

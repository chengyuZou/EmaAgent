import type { SessionId, TurnId, MessageId } from '@ema-agent/ids';
import type { MessageKind, MessageRole } from '@ema-agent/storage';
import type {
  ExecutionProfile,
  NarrativePolicy,
  Turn,
  TurnStatus,
  TurnTriggerType,
} from '@ema-agent/turn';
import type { MessageBlocks } from './message.js';
import type { ToolResultBlock } from './message.js';

// TODO: 禁止一切facade字段出现
/** Session 聚合向其他模块提供的归属校验端口。 */
export interface SessionOwnershipFacade {
  assertTurnOwnership(sessionId: SessionId, turnId: TurnId): void;
  assertMessageOwnership(sessionId: SessionId, messageId: MessageId): void;
}

// TODO: 字段没用
export type SessionOwnedEntity = 'message' | 'turn';

export interface Session {
  id: SessionId;
  title: string;
  /** 可空：未选=纯 chat 且 work 锁定；选定后可变（只影响后续 Turn 的运行环境）。 */
  workspaceRoot: string | null;
  createdAt: number;
  /** 行属性更新时间：标题、置顶、Workspace 或执行偏好发生变化。 */
  updatedAt: number;
  /** 会话活动时间，用于"最近 Session"排序。 */
  lastActivityAt: number;
  /** 非 null 即已封存；解封即置回 null。 */
  archivedAt: number | null;
  pinned: boolean;
  /** fork 溯源：来源 Session 与截断点 Turn（完整复制时为 null）。 */
  forkedFromSessionId: SessionId | null;
  forkedFromTurnId: TurnId | null;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  /** 用户希望该 Session 下一轮默认使用的供应商配置；null 表示使用系统默认选择。 */
  preferredProviderConfigId: string | null;
  /** 用户希望该 Session 下一轮默认使用的模型；null 表示使用系统默认选择。 */
  preferredModelId: string | null;
  lastViewedAt: number | null;
}

/**
 * 列表查询返回的投影：三个字段由列表 SQL 的 CTE 算出，只有列表路径有真值，
 * 单条查询返回 Session 本体，不允许伪造投影。
 */
export interface SessionListItem extends Session {
  // TODO: 一般来说 一个Session里面最多跑一个Turn 所以这个字段可能没用 要么改为 Turn数量
  /** 当前 running 状态的 Turn 数（侧栏运行指示）。 */
  runningTurnCount: number;
  /** 最近一次 Turn 的终态（侧栏红点；null = 从未运行）。 */
  lastTurnStatus: TurnStatus | null;
  /** 离开后有新活动：lastActivityAt > lastViewedAt（侧栏绿点）。 */
  hasUnread: boolean;
}

export interface Message {
  id: MessageId;
  sessionId: SessionId;
  /** null = Session 级消息（如 /compact 的 summary），不归属任何 Turn。 */
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

/** 启动恢复从 Message 读取的 Tool 调用与既有结果，不依赖执行状态表正文。 */
export interface PersistedToolInteraction {
  name: string;
  args: unknown;
  result?: ToolResultBlock;
}

// SessionStore 的输入输出契约。

export interface CreateSessionInput {
  title?: string;
  workspaceRoot?: string | null;
}

/** 用户可在 Session 存续期间修改的偏好；undefined 表示保持原值。 */
export interface PatchSessionInput {
  title?: string;
  pinned?: boolean;
  workspaceRoot?: string | null;
  executionProfile?: ExecutionProfile;
  narrativePolicy?: NarrativePolicy;
  preferredModel?: {
    providerConfigId: string;
    modelId: string;
  } | null;
}

export interface AppendMessageInput {
  turnId: TurnId | null;
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
   * 上一页返回的不透明 cursor。调用方只能原样回传，不能解析或构造。
   * 服务端使用 `(pinned DESC, last_activity_at DESC, id DESC)` 做稳定分页。
   */
  cursor?: string;
}

export interface ListSessionsOutput {
  sessions: SessionListItem[];
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
  createdAt: number;
  completedAt: number | null;
  status: TurnStatus;
  triggerType: TurnTriggerType;
  executionProfile: ExecutionProfile;
  /** 首条 User Message 的正文预览；用户输入的唯一事实源是 Message。 */
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
  session: SessionListItem;
  matchKind: 'title' | 'message';
  snippet: string;
  messageId: MessageId | null;
  messageAt: number | null;
}

export interface SearchSessionsOutput {
  results: SessionSearchHit[];
}

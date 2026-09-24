import type { MessageKind, MessageRole } from '@ema-agent/storage';
import type { MessageBlocks } from './message.js';
import type { ToolResult } from '@ema-agent/tools';
import type { PermissionMode } from '@ema-agent/permission';
import type { LlmThinkingEffort } from '@ema-agent/llm';

/**
 * Session 选用 Chat 或 Work 的方式; 输入渠道和连接协议不属于这个选择。
 * Turn 启动时记录当时的模式, 后来切换 Session 模式不会改写旧 Turn。
 */
export type SessionMode = 'chat' | 'work';

/**
 * Narrative 只控制剧情检索策略，不改变角色身份或创建第三套 Engine。
 * 会话级偏好；Turn 保存当次实际值，保证历史可解释。
 */
export type NarrativePolicy = 'auto' | 'always' | 'off';

/** Session 的推理选择. off 明确要求协议关闭推理, 不表示沿用模型默认值. */
export type ReasoningEffort = 'off' | LlmThinkingEffort;

/**
 * Turn 的持久化生命周期状态：创建即 running，没有持久化的 pending；
 * 根终态由 TurnExecutor 统一写入。注意：它属于单个 Turn，不是 Session 参数；
 * Session 只有派生投影 SessionListItem.lastTurnStatus。
 */
export type TurnStatus = 'running' | 'completed' | 'failed' | 'aborted';

/** 项目属性、源文件夹与侧栏当前显示的成员 Session；置顶 Session 单独显示。 */
export interface Project {
  id: string;
  name: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  folders: ProjectFolder[];
  sessions: SessionListItem[];
}

export interface ProjectFolder {
  path: string;
  isPrimary: boolean;
  createdAt: number;
  /** 只在"设为主要"时写入；null = 从未当过主，排序沉底。 */
  updatedAt: number | null;
}

export interface Session {
  id: string;
  title: string;
  /** 命令和相对路径的起点；创建时选定，之后只由用户显式修改。 */
  cwd: string;
  /** 项目成员资格；项目文件夹清单决定授权范围，不改写 cwd。 */
  projectId: string | null;
  createdAt: number;
  /** 行属性更新时间：标题、置顶、cwd 或执行偏好发生变化。 */
  updatedAt: number;
  /** 会话活动时间，用于时间展示与未读判断。 */
  lastActivityAt: number;
  /** 非 null 即已封存；解封即置回 null。 */
  archivedAt: number | null;
  pinned: boolean;
  /** fork 溯源：来源 Session 与截断点 Turn（完整复制时为 null）。 */
  forkedFromSessionId: string | null;
  forkedFromTurnId: string | null;
  sessionMode: SessionMode;
  narrativePolicy: NarrativePolicy;
  permissionMode: PermissionMode;
  /** 此 Session 启动新 Turn 时是否生成并播放语音; 不影响已开始的 Turn. */
  ttsEnabled: boolean;
  /** 已保存的模型供应商; null 表示新会话尚未选模型, 此时不能开始 Turn. */
  providerId: string | null;
  /** 与 providerId 成对保存的模型 ID; null 时不能开始 Turn. */
  modelId: string | null;
  reasoningEffort: ReasoningEffort;
  lastViewedAt: number | null;
}

/**
 * 列表查询返回的投影：三个字段由列表 SQL 的 CTE 算出，只有列表路径有真值，
 * 单条查询返回 Session 本体，不允许伪造投影。
 */
export interface SessionListItem extends Session {
  /** 当前是否有 running 状态的根 Turn（侧栏运行指示；同一 Session 至多一个在跑）。 */
  hasActiveTurn: boolean;
  /** 最近一次 Turn 的终态（侧栏红点；null = 从未运行）。 */
  lastTurnStatus: TurnStatus | null;
  /** 离开后有新活动：lastActivityAt > lastViewedAt（侧栏绿点）。 */
  hasUnread: boolean;
}

export interface Message {
  id: string;
  role: MessageRole;
  kind: MessageKind;
  /**
   * 已解析的内容块: User 可包含媒体或 Tool Result,
   * Assistant 保留 text、thinking 与 tool_use 的原始顺序.
   */
  blocks: MessageBlocks;
  interrupted: boolean;
  createdAt: number;
}

export interface SessionMessage extends Message {
  sessionId: string;
  /** null = Session 级消息（如 /compact 的 summary），不归属任何 Turn。 */
  turnId: string | null;
}

/** 启动恢复从 Message 读取的 Tool 调用与既有结果，不依赖执行状态表正文。 */
export interface PersistedToolInteraction {
  name: string;
  args: unknown;
  result?: ToolResult;
}

// SessionStore 的输入输出契约。

export interface CreateSessionInput {
  title?: string;
  cwd?: string;
  /** 项目新对话的初始 cwd 取创建时的主文件夹；无主文件夹取固定默认目录。 */
  projectId?: string;
  sessionMode?: SessionMode;
  narrativePolicy?: NarrativePolicy;
  permissionMode?: PermissionMode;
  ttsEnabled?: boolean;
  providerId?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
}

/** 用户可在 Session 存续期间修改的偏好；undefined 表示保持原值。 */
export interface PatchSessionInput {
  title?: string;
  pinned?: boolean;
  cwd?: string;
  sessionMode?: SessionMode;
  narrativePolicy?: NarrativePolicy;
  permissionMode?: PermissionMode;
  ttsEnabled?: boolean;
  /** 换模型时与 modelId 同传; 只改推理强度时两者都省略. */
  providerId?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface AppendMessageInput {
  turnId: string | null;
  sessionId: string;
  role: MessageRole;
  kind?: MessageKind;
  blocks: MessageBlocks;
  interrupted?: boolean;
}

export interface ListMessagesInput {
  /** 向更早方向读取时原样回传的游标. */
  before?: string;
  /** 向更新方向读取时原样回传的游标, 不能与 before 同时传入. */
  after?: string;
  limit?: number;
}

export interface MessagePage {
  messages: SessionMessage[];
  olderCursor?: string;
  newerCursor?: string;
}

export interface ListMessagesAroundInput {
  anchorMessageId: string;
  before?: number;
  after?: number;
}

export interface MessageWindow {
  messages: SessionMessage[];
  /** 窗口左侧还有消息时返回, 后续通过 listMessages({ before }) 继续读取. */
  olderCursor?: string;
  /** 窗口右侧还有消息时返回, 后续通过 listMessages({ after }) 继续读取. */
  newerCursor?: string;
}

export interface SearchSessionsInput {
  query: string;
  limit?: number;
}

export interface SessionSearchHit {
  session: SessionListItem;
  matchKind: 'title' | 'message';
  snippet: string;
  anchorMessageId: string | null;
  messageAt: number | null;
}

export interface SearchSessionsOutput {
  results: SessionSearchHit[];
}

export type SessionSidebarDestination =
  | { section: 'pinned' }
  | { section: 'project'; projectId: string }
  | { section: 'recent' };

export interface MoveSessionInSidebarInput {
  sessionId: string;
  destination: SessionSidebarDestination;
  /** null 表示放到目标分区末尾。 */
  beforeSessionId: string | null;
}

export interface MoveProjectInSidebarInput {
  projectId: string;
  section: 'pinned' | 'projects';
  /** null 表示放到目标分区末尾。 */
  beforeProjectId: string | null;
}

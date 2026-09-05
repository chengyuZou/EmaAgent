import type { MessageKind, MessageRole } from '@ema-agent/storage';
import type { MessageBlocks } from './message.js';
import type { ToolResult } from '@ema-agent/tools';

/**
 * 一次 Turn 的执行能力范围；输入渠道和连接协议不属于 Profile。
 * 会话级默认偏好：Turn 启动时复制并冻结为历史事实。
 */
export type ExecutionProfile = 'chat' | 'work';

/**
 * Narrative 只控制剧情检索策略，不改变角色身份或创建第三套 Engine。
 * 会话级偏好；Turn 保存当次实际值，保证历史可解释。
 */
export type NarrativePolicy = 'auto' | 'always' | 'off';

/**
 * Turn 的持久化生命周期状态：创建即 running，没有持久化的 pending；
 * 根终态由 TurnExecutor 统一写入。注意：它属于单个 Turn，不是 Session 参数；
 * Session 只有派生投影 SessionListItem.lastTurnStatus。
 */
export type TurnStatus = 'running' | 'completed' | 'failed' | 'aborted';

/** 项目实体：可编辑名称 + 多源文件夹（恰好一个主文件夹）。 */
export interface Project {
  id: string;
  name: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectFolder {
  path: string;
  isPrimary: boolean;
  createdAt: number;
  /** 只在"设为主要"时写入；null = 从未当过主，排序沉底。 */
  updatedAt: number | null;
}

/** 侧栏一个项目槽：实体 + 文件夹 + 成员 Session。 */
export interface ProjectGroup {
  project: Project;
  folders: ProjectFolder[];
  sessions: SessionListItem[];
}

export interface Session {
  id: string;
  title: string;
  /** 可空：未选=纯 chat 且 work 锁定；在项目内锁定为项目主文件夹。 */
  workspaceRoot: string | null;
  /** 项目成员资格；拖入锁定跟随主工作区，拖出恢复自由。 */
  projectId: string | null;
  createdAt: number;
  /** 行属性更新时间：标题、置顶、Workspace 或执行偏好发生变化。 */
  updatedAt: number;
  /** 会话活动时间，用于"最近 Session"排序。 */
  lastActivityAt: number;
  /** 非 null 即已封存；解封即置回 null。 */
  archivedAt: number | null;
  pinned: boolean;
  /** fork 溯源：来源 Session 与截断点 Turn（完整复制时为 null）。 */
  forkedFromSessionId: string | null;
  forkedFromTurnId: string | null;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  /** 用户希望该 Session 使用的供应商配置；null 表示使用系统默认选择。 */
  providerId: string | null;
  /** 用户希望该 Session 使用的模型；null 表示使用系统默认选择。 */
  modelId: string | null;
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
  sessionId: string;
  /** null = Session 级消息（如 /compact 的 summary），不归属任何 Turn。 */
  turnId: string | null;
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
  result?: ToolResult;
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
  model?: {
    providerId: string;
    modelId: string;
  } | null;
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
  /** 加载早于该时间戳的消息，供 UI 热历史分页。 */
  before?: number;
  limit?: number;
}

export interface SearchSessionsInput {
  query: string;
  limit?: number;
}

export interface SessionSearchHit {
  session: SessionListItem;
  matchKind: 'title' | 'message';
  snippet: string;
  messageId: string | null;
  messageAt: number | null;
}

export interface SearchSessionsOutput {
  results: SessionSearchHit[];
}

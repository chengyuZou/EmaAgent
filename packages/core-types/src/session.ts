/**
 * 会话与消息的核心类型定义。
 *
 * V1 的关键约束：session 只承载连续上下文，不绑定固定模式；每轮 turn
 * 通过 turn.mode 决定使用 chat / agent / narrative 哪条执行链。
 */

import type { EmaMode } from "./modes.js";

/** 消息角色。 */
export type MessageRole = "user" | "assistant" | "system" | "tool";

/** 消息正文块，方便后续支持附件、代码块和富文本。 */
export type MessageContentBlock =
  | { type: "text"; text: string }
  | { type: "render_ref"; blockId: string }
  | { type: "artifact_ref"; artifactId: string }
  | { type: "tool_result_ref"; toolCallId: string };

/** 统一消息结构，所有交互历史落盘均使用此类型。 */
export interface ChatMessage {
  /** 消息唯一 ID。 */
  id: string;
  /** 角色。 */
  role: MessageRole;
  /** 兼容旧代码的纯文本正文；新代码应同时写 contentBlocks。 */
  content: string;
  /** 结构化正文块。 */
  contentBlocks?: MessageContentBlock[];
  /** 关联的 turn requestId。 */
  requestId?: string;
  /** 关联的工具调用请求 ID，仅 tool 角色需要。 */
  toolCallId?: string;
  /** 工具调用列表，仅 assistant 角色可能携带。 */
  toolCalls?: ToolCall[];
  /** 创建时间戳。 */
  createdAt: number;
}

/** 工具调用请求。 */
export interface ToolCall {
  /** 调用 ID。 */
  id: string;
  /** 目标工具名称。 */
  toolName: string;
  /** 结构化参数。 */
  arguments: Record<string, unknown>;
}

/** 工具调用结果。 */
export interface ToolResult {
  /** 对应调用 ID。 */
  toolCallId: string;
  /** 工具名称。 */
  toolName: string;
  /** 执行是否成功。 */
  success: boolean;
  /** 结果内容。 */
  content: string;
  /** 错误信息，success 为 false 时使用。 */
  error?: string;
  /** 执行耗时，单位毫秒。 */
  durationMs: number;
}

/** 会话标题状态。 */
export type SessionTitleStatus = "default" | "pending" | "generated" | "fallback" | "manual" | "failed";

/** 会话持久状态。 */
export interface SessionState {
  /** 会话 ID。 */
  id: string;
  /** 会话标题，可自动提取。 */
  title: string;
  /** 消息列表。 */
  messages: ChatMessage[];
  /** 创建时间戳。 */
  createdAt: number;
  /** 最后更新时间戳。 */
  updatedAt: number;
  /** 当前会话是否启用了全权限。 */
  fullAccess: boolean;
  /** 已注入的 skill ID 列表。 */
  activeSkills: string[];
  /** 当前会话的标题状态。 */
  titleStatus: SessionTitleStatus;
  /** 标题最后更新时间戳，用于标题状态管理。 */
  titleUpdatedAt?: number;
  /** 该 session 上一次使用的模式，只作为下一次输入的默认值。 */
  modeLast: EmaMode;
  /** 兼容旧代码的别名；新代码禁止把它当 session 固定类型。 */
  mode?: EmaMode;
}

/** 创建会话时需要的最小输入。 */
export interface CreateSessionInput {
  /** 会话 ID。 */
  id: string;
  /** 初始标题，不传则由 session-runtime 使用默认标题。 */
  title?: string;
  /** 初始默认模式。 */
  modeLast?: EmaMode;
  /** 创建时间戳，不传则由 repository 写入当前时间。 */
  createdAt?: number;
}

/** 会话摘要，列表展示用，避免加载完整消息。 */
export interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: number;
  /** 列表中恢复模式选择器默认值。 */
  modeLast: EmaMode;
}

/** 分页读取消息的参数。 */
export interface ListMessagesOptions {
  /** 每页最大条数。 */
  limit?: number;
  /** 只读取早于该时间戳的消息。 */
  beforeCreatedAt?: number;
  /** 是否包含 system 消息。 */
  includeSystem?: boolean;
  /** 是否包含 tool 消息。 */
  includeTool?: boolean;
}

/** 消息分页结果。 */
export interface MessagePage {
  /** 当前页消息，按时间升序返回。 */
  items: ChatMessage[];
  /** 是否还有更早消息。 */
  hasMore: boolean;
  /** 下一页游标，通常是最早消息的 createdAt。 */
  nextBeforeCreatedAt?: number;
}

/** 工具调用元数据，用于 metadata 流。 */
export interface ToolCallMeta {
  requestId: string;
  toolCallId: string;
  toolName: string;
  status: "pending" | "executing" | "success" | "error" | "denied";
  durationMs?: number;
  errorCode?: string;
}

/** 工具确认弹窗载荷。 */
export interface ToolConfirmPayload {
  requestId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: "low" | "medium" | "high";
  timeoutMs: number;
}

/** 会话仓储接口。由 storage-sql 实现，session-runtime 消费。 */
export interface SessionRepository {
  getById(sessionId: string): Promise<SessionState | null>;
  create(input: CreateSessionInput): Promise<SessionState>;
  save(session: SessionState): Promise<void>;
  list(): Promise<SessionSummary[]>;
  listMessages(sessionId: string, options?: ListMessagesOptions): Promise<MessagePage>;
  appendMessage(sessionId: string, message: ChatMessage): Promise<void>;
  updateTitle(sessionId: string, title: string, status?: SessionTitleStatus): Promise<void>;
  updateModeLast(sessionId: string, mode: EmaMode): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

/** 是否需要生成标题。 */
export interface ShouldGenerateTitleRequest {
  session: SessionState;
}

/** 生成标题请求。 */
export interface GenerateSessionTitleRequest {
  session: SessionState;
}

/** 会话标题结果。 */
export interface SessionTitleResult {
  title: string;
  status: SessionTitleStatus;
}

import type { ArtifactSummary, DiffSummary } from "./artifacts.js";
import type { EmaMode } from "./modes.js";

/**
 * turn 是 V1 的主执行单位。
 *
 * session 负责承载上下文；turn 负责记录本轮使用的 mode、模型、步骤、产物和用量。
 */

/** 一轮请求的输入块。 */
export type TurnInputBlock =
  | { type: "text"; text: string }
  | { type: "image_ref"; attachmentId: string }
  | { type: "file_ref"; attachmentId: string };

/** 发起 turn 的 API 请求体。 */
export interface StartTurnRequest {
  /** 会话 ID。 */
  sessionId: string;
  /** 本轮执行模式，不代表 session 类型。 */
  mode: EmaMode;
  /** 本轮输入，可以混合文本和附件引用。 */
  input: TurnInputBlock[];
  /** 兼容旧前端的单文本入口，BFF 会转换成 input[0]。 */
  rawUserQuery?: string;
  /** 参与本轮上下文构建的附件 ID。 */
  attachments?: string[];
  /** 本轮临时模型覆盖，不写入全局绑定。 */
  modelOverrides?: Partial<{
    chatModelId: string;
    agentModelId: string;
    narrativeModelId: string;
    titleModelId: string;
  }>;
  /** 客户端能力与区域信息。 */
  client?: {
    locale?: string;
    timezone?: string;
    supportsMermaid?: boolean;
    supportsLatex?: boolean;
  };
}

/** 发起 turn 后的响应。 */
export interface StartTurnResponse {
  requestId: string;
  sessionId: string;
  acceptedAt: number;
  streamUrl: string;
}

/** turn 的持久化状态。 */
export type TurnStatus = "queued" | "running" | "waiting_permission" | "completed" | "failed" | "cancelled";

/** StepTimelinePane 使用的步骤状态。 */
export type StepStatus = "pending" | "running" | "waiting_permission" | "completed" | "failed" | "skipped";

/** 结构化步骤视图，三模式都可以发，agent 使用最频繁。 */
export interface StepView {
  id: string;
  requestId: string;
  type: "context" | "thinking" | "tool" | "diff" | "artifact" | "response" | "narrative_recall";
  status: StepStatus;
  title: string;
  detail?: string;
  startedAt?: number;
  endedAt?: number;
  artifactIds?: string[];
}

/** 单轮持久化视图，给调试页和审计页使用。 */
export interface TurnRecord {
  requestId: string;
  sessionId: string;
  mode: EmaMode;
  status: TurnStatus;
  modelId?: string;
  providerId?: string;
  startedAt: number;
  endedAt?: number;
  usage?: UsageView;
  artifacts?: ArtifactSummary[];
  diffs?: DiffSummary[];
}

/** 创建 turn 的仓储输入。 */
export interface CreateTurnInput {
  requestId: string;
  sessionId: string;
  mode: EmaMode;
  status?: TurnStatus;
  modelId?: string;
  providerId?: string;
  startedAt?: number;
}

/** 更新 turn 状态和统计信息的仓储输入。 */
export interface UpdateTurnInput {
  requestId: string;
  status?: TurnStatus;
  modelId?: string;
  providerId?: string;
  endedAt?: number;
  usage?: UsageView;
  costUsd?: number;
}

/** 按会话列出 turns 的分页参数。 */
export interface ListTurnsOptions {
  limit?: number;
  beforeStartedAt?: number;
}

/** turns 分页结果。 */
export interface TurnPage {
  items: TurnRecord[];
  hasMore: boolean;
  nextBeforeStartedAt?: number;
}

/** turn 仓储接口，session-runtime 通过它持久化每轮执行状态。 */
export interface TurnRepository {
  createTurn(input: CreateTurnInput): Promise<TurnRecord>;
  getTurnById(requestId: string): Promise<TurnRecord | null>;
  updateTurn(input: UpdateTurnInput): Promise<void>;
  listTurnsBySession(sessionId: string, options?: ListTurnsOptions): Promise<TurnPage>;
}

/** 统一 token / 成本用量视图。 */
export interface UsageView {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

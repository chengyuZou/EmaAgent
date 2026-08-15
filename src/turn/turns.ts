// 定义 Turn 的领域词汇、领域对象、创建输入、Wire 请求与终态统计。
// 本文件是词汇叶（只依赖 ids 与 llm 的内容词汇类型）：任何包都可以 import 它，它永不 import 业务包。

import type { ContentPart } from '@ema-agent/llm';

/** 用户提交给 Turn 的附件能力与展示元数据。 */
export interface TurnAttachment {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  mtime?: number;
  fileHandle?: string | null;
}

/** 一次 Turn 的执行能力范围；输入渠道和连接协议不属于 Profile。 */
export type ExecutionProfile = 'chat' | 'work';

/** Narrative 只控制剧情检索策略，不改变角色身份或创建第三套 Engine。 */
export type NarrativePolicy = 'auto' | 'always' | 'off';

/** Turn 的持久化生命周期状态：创建即 running，没有持久化的 pending；根终态由 TurnExecutor 统一写入。 */
export type TurnStatus = 'running' | 'completed' | 'failed' | 'aborted';

/**
 * 公开 Turn 触发源。`backgroundProcessCompleted` 由 Server 内部创建，
 * HTTP 客户端不能伪造。
 */
export type TurnTriggerType = 'userMessage' | 'backgroundProcessCompleted';

// ── Turn 领域对象（事实源；持久化行见 storage TurnRow，边界显式映射） ──────────

export interface Turn {
  readonly id: string;
  readonly sessionId: string;
  readonly status: TurnStatus;
  readonly triggerType: TurnTriggerType;
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
  /** 操作开始冻结的模型选择；prepare 解析成功前为 null。 */
  readonly providerConfigId: string | null;
  readonly modelId: string | null;
  readonly iterations: number;
  readonly usageInputTokens: number;
  readonly usageOutputTokens: number;
  /** 创建即启动的唯一时序事实：排序、分页、时长与 fork 截断都用它。 */
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface StartTurnInput {
  /** 内部恢复流程可预留稳定身份；公开请求始终由 Store 生成。 */
  readonly turnId?: string;
  readonly sessionId: string;
  readonly triggerType: TurnTriggerType;
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
}

export interface CompleteTurnInput {
  readonly usageInputTokens?: number;
  readonly usageOutputTokens?: number;
  readonly iterations?: number;
}

// ── Turn 导航查询的输入输出（TurnStore 的读取面） ─────────────────────────────

export interface ListTurnIndexInput {
  /** 上一页返回的不透明游标，只能原样回传。 */
  cursor?: string;
  limit?: number;
}

export interface TurnIndexItem {
  turnId: string;
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

export interface ListTurnWindowInput {
  anchorTurnId: string;
  /** 锚点之前需要读取的较旧 Turn 数量。 */
  beforeTurns?: number;
  /** 锚点之后需要读取的较新 Turn 数量。 */
  afterTurns?: number;
}

/** 锚点窗口只含 Turn；消息正文由 session 侧按 turnIds 另取后由拼装层合成。 */
export interface TurnWindow {
  anchorTurnId: string;
  turns: Turn[];
  hasOlder: boolean;
  hasNewer: boolean;
}

// ── POST /api/turns 的请求体 ──────────────────────────────────────────────────
//
// Wire 类型一律用 plain string（JSON 实际形态），不用 branded ID——brand 是
// 内部类型安全工具，边界在 route handler（asSessionId / asTurnId 转换）。
// 与 SessionWire.id: string 同惯例。

/**
 * userInput、contentParts 和 attachments 至少要有一个有效输入。
 * sessionId 省略时后端自动创建新 session 并返回生成的 sessionId。
 * providerId + model 省略时由 Turn 输入准备层使用当前 Profile 的模型绑定。
 * providerId 和 model 应成对出现——前端选择器选的是 (provider, model) 组合，
 * 因为同名模型可能存在于多个供应商下。
 */
export interface TurnRequest {
  sessionId?:    string;             // 省略 → 自动创建新 session
  /** HTTP 只能发起用户触发；backgroundProcessCompleted 由 Server 内部创建。 */
  trigger:        'userMessage';
  executionProfile: ExecutionProfile;
  narrativePolicy:  NarrativePolicy;
  userInput?:    string;
  contentParts?: ContentPart[];
  attachments?:  TurnAttachment[];
  /** provider_configs.id — 本次 turn 使用的供应商实例。和 model 成对使用。 */
  providerId?:   string;
  /** 模型名。如果有 providerId，此模型必须在该供应商下已启用。 */
  model?:        string;
  ttsEnabled?:      boolean;
  /** 用户开启“思考”开关；支持范围由模型能力快照和输入准备层校验。 */
  thinkingEnabled?: boolean;
  /** 用户在聊天选择器中选中的唯一 KB；只影响本 Turn 的检索范围。 */
  kbId?:            string;
  /** 该 KB 内选中的文档范围；省略时不额外限制，检索策略由 Knowledge Tool 与 Profile 决定。 */
  kbAssetIds?:      string[];
}

export type TurnRequestInput = Pick<
  TurnRequest,
  'userInput' | 'contentParts' | 'attachments'
>;

export function hasTurnRequestInput(input: TurnRequestInput): boolean {
  return Boolean(
    input.userInput?.trim()
      || input.contentParts?.length
      || input.attachments?.length,
  );
}



// ── 本轮统计（被 turn_completed SSE 事件引用） ────────────────────────────────
//
// 命名注意：这是"turn 终态摘要"不是 provider 的 usage 对象——token（账单）与
// durationMs（秒表）出身不同但消费场景 100% 重合，故同居一个类型。
// 曾名 UsageSummary，因名字暗示"纯 token 计量"导致 subagent_completed 事件
// 在外面重复携带过一次 durationMs——名不正则字段歪。

export interface TurnStats {
  inputTokens:  number;
  outputTokens: number;
  durationMs:   number;
}

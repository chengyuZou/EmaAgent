// 定义 Turn 的请求、创建响应、输入校验与终态统计。
/** Turn 输入边界允许携带的文本与媒体内容。 */
export type TurnContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; url: string; name?: string; width?: number; height?: number }
  | { type: 'image_data'; data: string; mimeType: string; name?: string; width?: number; height?: number }
  | { type: 'audio_data'; data: string; mimeType: string; name?: string; durationMs?: number }
  | { type: 'file_data'; data: string; mimeType: string; filename?: string; pageCount?: number }
  | { type: 'file_url'; url: string; mimeType: string; filename?: string; pageCount?: number };

/** 用户提交给 Turn 的附件能力与展示元数据。 */
export interface TurnAttachment {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  mtime?: number;
  fileHandle?: string | null;
}

/** 当前 Turn 在某个知识库内允许检索的文档范围。 */
export interface KbAssetScope {
  kbId: string;
  assetIds: string[];
}

/** 一次 Turn 的执行能力范围；输入渠道和连接协议不属于 Profile。 */
export type ExecutionProfile = 'chat' | 'work';

/** Narrative 只控制剧情检索策略，不改变角色身份或创建第三套 Engine。 */
export type NarrativePolicy = 'auto' | 'always' | 'off';

/** Turn 的持久化生命周期状态；根终态由 TurnExecutor 统一写入。 */
export type TurnStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';

/** 用户主动提交的公开 Turn 触发源。 */
export interface UserMessageTurnTrigger {
  readonly type: 'userMessage';
}

/** 后台进程自然结束后由 LocalHost 内部创建，HTTP 客户端不能伪造。 */
export interface BackgroundProcessCompletedTurnTrigger {
  readonly type: 'backgroundProcessCompleted';
}

export type TurnTrigger =
  | UserMessageTurnTrigger
  | BackgroundProcessCompletedTurnTrigger;
export type TurnTriggerType = TurnTrigger['type'];

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
  trigger:        UserMessageTurnTrigger;
  executionProfile: ExecutionProfile;
  narrativePolicy:  NarrativePolicy;
  userInput?:    string;
  contentParts?: TurnContentPart[];
  attachments?:  TurnAttachment[];
  /** provider_configs.id — 本次 turn 使用的供应商实例。和 model 成对使用。 */
  providerId?:   string;
  /** 模型名。如果有 providerId，此模型必须在该供应商下已启用。 */
  model?:        string;
  ttsEnabled?:      boolean;
  /** 用户开启“思考”开关；支持范围由模型能力快照和输入准备层校验。 */
  thinkingEnabled?: boolean;
  /** 用户在聊天选择器中选中的 KB；只影响本 Turn 的检索范围。 */
  kbIds?:           string[];
  /**
   * 每个 KB 内选中的文档范围。省略时不额外限制该 KB；具体检索策略由
   * Knowledge Tool 与当前 ExecutionProfile 决定。
   */
  kbAssetScopes?:   KbAssetScope[];
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

// ── POST /api/turns 的响应体 ─────────────────────────────────────────────────

/**
 * 创建 turn 后立即返回，客户端拿到 turnId 去订阅 SSE。
 * sessionId 返回实际使用的 session（可能是刚创建的新 session）。
 */
export interface TurnCreatedResponse {
  turnId:    string;
  sessionId: string;
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

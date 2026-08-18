// 权限领域词汇：规则、决策、上下文与批准请求。

// ── 模式与行为 ────────────────────────────────────────────────────────────────

/** bypassPermissions 仅显式开发入口可开启；正式装配必须禁用。 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

export type PermissionBehavior = 'allow' | 'deny' | 'ask';

// ── 规则 ─────────────────────────────────────────────────────────────────────

/**
 * 规则来源。userSettings=全局个人规则；projectSettings=按 projectId 绑项目规则；
 * session=本会话即效（纯内存，不落盘）。没有 localSettings（单人单机无"项目内本机"层）。
 */
export type PermissionRuleSource = 'userSettings' | 'projectSettings' | 'session';

/** 规则值：作用于哪个 Tool，可选内容（语义由 Tool 家族 matcher 解释，中央不解释）。 */
export interface PermissionRuleValue {
  readonly toolName: string;
  readonly ruleContent?: string;
}

export interface PermissionRule {
  readonly source: PermissionRuleSource;
  readonly ruleBehavior: PermissionBehavior;
  readonly ruleValue: PermissionRuleValue;
}

export type PermissionUpdateDestination = PermissionRuleSource;

/** 用户选择沉淀为配置更新："本 Session 允许" = addRules(session)；写设置 = addRules(user/project)。 */
export type PermissionUpdate =
  | {
      readonly type: 'addRules';
      readonly destination: PermissionUpdateDestination;
      readonly rules: readonly PermissionRuleValue[];
      readonly behavior: PermissionBehavior;
    }
  | {
      readonly type: 'removeRules';
      readonly destination: PermissionUpdateDestination;
      readonly rules: readonly PermissionRuleValue[];
      readonly behavior: PermissionBehavior;
    }
  | {
      readonly type: 'setMode';
      readonly destination: PermissionUpdateDestination;
      readonly mode: PermissionMode;
    };

// ── 决策 ─────────────────────────────────────────────────────────────────────

export type PermissionDecisionReason =
  | { readonly type: 'rule'; readonly rule: PermissionRule }
  | { readonly type: 'mode'; readonly mode: PermissionMode }
  /** Bash 复合命令逐个子命令各自的判定；键 = 子命令文本。 */
  | { readonly type: 'subcommandResults'; readonly reasons: ReadonlyMap<string, PermissionResult> }
  | { readonly type: 'workingDir'; readonly reason: string }
  /** Tool 自检拦截（敏感路径/危险输入）；先于 bypass 生效。 */
  | { readonly type: 'safetyCheck'; readonly reason: string }
  | { readonly type: 'user'; readonly action: PermissionResponse['action'] }
  /** 无交互通道（headless/子 Agent）时 ask 被收口为 deny。 */
  | { readonly type: 'headless' }
  | { readonly type: 'other'; readonly reason: string };

export interface PermissionAllowDecision {
  readonly behavior: 'allow';
  readonly decisionReason?: PermissionDecisionReason;
}

export interface PermissionAskDecision {
  readonly behavior: 'ask';
  readonly message: string;
  readonly decisionReason?: PermissionDecisionReason;
}

export interface PermissionDenyDecision {
  readonly behavior: 'deny';
  readonly message: string;
  readonly decisionReason?: PermissionDecisionReason;
}

export type PermissionDecision =
  | PermissionAllowDecision
  | PermissionAskDecision
  | PermissionDenyDecision;

/**
 * Tool.checkPermissions 的返回。passthrough 只允许 Tool 返回给中央，
 * 表示"我没有允许或拒绝的理由，请中央规则与模式收口"；公共终态仍是 allow/ask/deny。
 */
export type PermissionResult =
  | PermissionDecision
  | {
      readonly behavior: 'passthrough';
      readonly message: string;
      readonly decisionReason?: PermissionDecisionReason;
    };

// ── 上下文 ────────────────────────────────────────────────────────────────────

/**
 * 按来源分组的规则集，值是原始规则字符串（'Tool' 或 'Tool(content)'）。
 * 解析推迟到各 Tool 家族 match 时——中央永远不需要懂 ruleContent 语义。
 */
export type ToolPermissionRulesBySource = Partial<
  Record<PermissionRuleSource, readonly string[]>
>;

/** 一次判定的完整上下文：模式 + 冻结规则集 + 身份。settings 源规则 Turn 冻结；session 源本 Turn 即效。 */
export interface ToolPermissionContext {
  readonly mode: PermissionMode;
  readonly alwaysAllowRules: ToolPermissionRulesBySource;
  readonly alwaysDenyRules: ToolPermissionRulesBySource;
  readonly alwaysAskRules: ToolPermissionRulesBySource;
  /** 正式构建 false；只有显式开发入口可为 true。 */
  readonly isBypassPermissionsModeAvailable: boolean;
  readonly workspaceRoot?: string;
  readonly sessionId: string;
  readonly toolCallId: string;
}


/** 批准卡唯一需要理解的投影：哪个 Tool、拿什么输入、为什么是 ask、定位三身份。 */
export interface PermissionRequest {
  readonly toolName: string;
  readonly toolDescription?: string;
  readonly input: unknown;
  readonly decisionReason?: PermissionDecisionReason;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
}

/** 待批准快照；Promise、计时器不进入事件协议。 */
export interface PendingPermissionRequest {
  readonly toolCallId: string;
  readonly createdAt: number;
  readonly request: PermissionRequest;
}

export type PermissionResponse =
  | { readonly action: 'allow' }
  | { readonly action: 'allowSession' }
  | { readonly action: 'deny'; readonly reason?: string };

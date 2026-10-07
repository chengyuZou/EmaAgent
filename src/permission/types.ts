// 权限领域词汇：规则、决策、上下文与批准请求。

// ── 模式与行为 ────────────────────────────────────────────────────────────────

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

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

export type SessionAllowRule = PermissionRuleValue
  & Required<Pick<PermissionRuleValue, 'ruleContent'>>;

export interface PermissionRule {
  readonly source: PermissionRuleSource;
  readonly ruleBehavior: PermissionBehavior;
  readonly ruleValue: PermissionRuleValue;
}

export type PermissionUpdateDestination = PermissionRuleSource;

/**
 * 用户选择沉淀为配置更新："本 Session 允许" = addRules(session)；写设置 = addRules(user/project)。
 * 模式由 Session 保存；这里仅处理 Tool 规则。
 */
export type PermissionUpdate =
  | {
    readonly type: 'addRules';
    readonly destination: 'session';
    readonly rules: readonly SessionAllowRule[];
    readonly behavior: 'allow';
  }
  | {
    readonly type: 'addRules';
    readonly destination: Exclude<PermissionUpdateDestination, 'session'>;
    readonly rules: readonly PermissionRuleValue[];
    readonly behavior: PermissionBehavior;
  }
  | {
    readonly type: 'removeRules';
    readonly destination: PermissionUpdateDestination;
    readonly rules: readonly PermissionRuleValue[];
    readonly behavior: PermissionBehavior;
  };

// ── 决策 ─────────────────────────────────────────────────────────────────────

export type PermissionDecisionReason =
  | { readonly type: 'rule'; readonly rule: PermissionRule }
  | { readonly type: 'mode'; readonly mode: PermissionMode }
  | { readonly type: 'workingDir'; readonly reason: string }
  /** Tool 自检拦截（敏感路径/危险输入）；先于 bypass 生效。 */
  | { readonly type: 'safetyCheck'; readonly reason: string }
  | { readonly type: 'user'; readonly action: PermissionResponse['action'] }
  /** 没有宿主交互通道时, ask 被收口为 deny. 子代理可使用所属 Session 的通道. */
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
  /** 后端等待回答时持有, 不进入前端批准协议. */
  readonly sessionAllowRule: SessionAllowRule;
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
  | PermissionDenyDecision
  | ((
    | PermissionAllowDecision
    | Omit<PermissionAskDecision, 'sessionAllowRule'>
    | {
      readonly behavior: 'passthrough';
      readonly message: string;
      readonly decisionReason?: PermissionDecisionReason;
    }
  ) & {
    /** 缺省时中央按本次已校验输入生成精确规则. */
    readonly sessionAllowRule?: SessionAllowRule;
  });

// ── 上下文 ────────────────────────────────────────────────────────────────────

/**
 * 按来源分组的规则集，值是原始规则字符串（'Tool' 或 'Tool(content)'）。
 * 解析推迟到各 Tool 家族 match 时——中央永远不需要懂 ruleContent 语义。
 */
export type ToolPermissionRulesBySource = Partial<
  Record<PermissionRuleSource, readonly string[]>
>;

/**
 * 一次判定的完整上下文：模式 + 冻结规则集 + 项目当前授权目录。settings 源规则 Turn 冻结；
 * session 源本 Turn 即效。调用身份（sessionId/turnId/toolCallId）不属于判定上下文——
 * Tool 自检不需要它，批准卡身份由执行链装配进 PermissionRequest。
 */
export interface ToolPermissionContext {
  readonly mode: PermissionMode;
  readonly alwaysAllowRules: ToolPermissionRulesBySource;
  readonly alwaysDenyRules: ToolPermissionRulesBySource;
  readonly alwaysAskRules: ToolPermissionRulesBySource;
  readonly workspaceRoots: readonly string[];
}


/** 批准请求: Session 负责排队, toolCallId 定位调用, Turn 或子代理 Run 负责收尾. */
export type PermissionRequest = {
  readonly toolName: string;
  readonly toolDescription?: string;
  readonly input: unknown;
  readonly decisionReason?: PermissionDecisionReason;
  readonly sessionId: string;
  /** 根请求是当前 Turn; 子代理请求是发起本次 Run 的父 Turn, 不代表清理归属. */
  readonly turnId: string;
  readonly toolCallId: string;
} & (
    | { readonly subagentId?: never; readonly runId?: never }
    | {
      /** 稳定的子代理身份, 用于批准卡标明来源. */
      readonly subagentId: string;
      /** 发起工具调用的本次执行, 用于 Run 收尾清理. 与 subagentId 一起提供. */
      readonly runId: string;
    }
  );

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

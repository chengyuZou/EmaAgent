export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export type PermissionBehavior = 'allow' | 'deny' | 'ask';

/**
 * 用户规则跨项目保存, 项目规则按 projectId 保存.
 * Session 规则只保存在内存, 新增后当前 Turn 的后续调用也能读到.
 */
export type PermissionRuleSource = 'userSettings' | 'projectSettings' | 'session';

/** 规则值:作用于哪个 Tool,可选内容(语义由 Tool 家族 matcher 解释,中央不解释). */
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
 * Session 只新增带内容的 allow 规则. 用户及项目配置允许整个工具或带内容的规则.
 * 模式单独保存在 Session, 此更新只处理工具规则.
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

export type PermissionDecisionReason =
  | { readonly type: 'rule'; readonly rule: PermissionRule }
  | { readonly type: 'mode'; readonly mode: PermissionMode }
  | { readonly type: 'workingDir'; readonly reason: string }
  /** Tool 因敏感路径或输入给出的确认或拒绝原因, 先于 bypass 判断. */
  | { readonly type: 'safetyCheck'; readonly reason: string }
  | { readonly type: 'user'; readonly action: PermissionResponse['action'] }
  /** 没有宿主交互通道, 无法询问用户时转为拒绝. */
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
 * Tool 可以用 passthrough 交给配置与模式继续判断, 中央最终返回 allow/ask/deny.
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

/**
 * 按来源保存 Tool 或 Tool(content) 字符串.
 * 中央解析工具名和内容边界, 内容的匹配含义由对应工具判断.
 */
export type ToolPermissionRulesBySource = Partial<
  Record<PermissionRuleSource, readonly string[]>
>;

/**
 * 模式, 用户/项目规则和工作区根在 Turn 准备时确定.
 * Session allow 通过 getter 读取当前规则, 使本轮及子代理能复用新批准.
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

/** 待批准列表只携带请求及创建时间, 不包含等待 Promise 或计时器. */
export interface PendingPermissionRequest {
  readonly toolCallId: string;
  readonly createdAt: number;
  readonly request: PermissionRequest;
}

export type PermissionResponse =
  | { readonly action: 'allow' }
  | { readonly action: 'allowSession' }
  | { readonly action: 'deny'; readonly reason?: string };

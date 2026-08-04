import type { SessionId, ToolCallId, TurnId } from '@ema-agent/ids';

export type Platform = 'windows' | 'wsl' | 'linux' | 'macos';

/** 权限模式属于一次执行快照，不能作为 PermissionEngine 的跨 Session 全局状态。 
 * | 模式 | 语义 |
 * |---|---|
 * | `default` | 工作区读取自动允许，其余按规则或询问 |
 * | `acceptEdits` | 额外允许工作区文件写入，不允许 execute |
 * | `bypassPermissions` | 仅显式开发入口可开启；正式装配必须禁用 |
*/
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

export type RuleScope = 'global' | 'workspace';
export type RiskLevel = 'low' | 'medium' | 'high';
export type AccessType = 'read' | 'write' | 'execute';
export type PermissionPathAccess = 'read' | 'write';
export type PermissionPromptPolicy = 'whenRequired' | 'neverForTrustedBuiltin';

/** Permission 可识别的内部目录能力；目录值必须由宿主的 RuntimePaths 生成。 */
export interface InternalPathCapabilities {
  /** 当前 Turn 的临时 scratchpad，根 Agent 与其子 Agent 可以共享。 */
  readonly turnScratchpad?: string;
}

export type InternalPathCapability = keyof InternalPathCapabilities;

/**
 * 表示一个 Tool 在对应作用域下的权限规则。规则由宿主持久化，PermissionEngine 只负责匹配和裁决。
 */
export interface PermissionRule {
  readonly action: 'allow' | 'deny' | 'ask';
  /** Tool 稳定 id，`*` 表示全部 Tool。 */
  readonly tool: string;
  /** 使用 gitignore 语义；省略时匹配该 Tool 的全部目标。 */
  readonly pathGlob?: string;
  readonly scope: RuleScope;
  /** workspace 规则必须绑定创建规则时的规范化工作区。 */
  readonly workspaceRoot?: string;
}

export interface PersistedPermissionRule extends PermissionRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PermissionToolIdentity {
  readonly id: string;
  readonly name: string;
  /** 只用于批准界面，不参与规则匹配。 */
  readonly description?: string;
}

/** Tool 把业务输入投影为 Permission 能理解的纯数据目标。 */
export interface PermissionPathTarget {
  readonly path: string;
  readonly accessType: PermissionPathAccess;
}

/** Tool 已完成 Schema、Context 和业务硬安全校验后产生的授权意图。 */
export interface PermissionIntent {
  readonly riskLevel: RiskLevel;
  readonly accessType: AccessType;
  readonly targets?: readonly PermissionPathTarget[];
  readonly internalPathCapability?: InternalPathCapability;
  readonly promptPolicy: PermissionPromptPolicy;
}

/**
 * 一次执行的上下文快照，不是全局状态。
 * 否则并发 Session 互相覆盖权限状态，导致安全漏洞。
 */
export interface PermissionContext {
  readonly mode: PermissionMode;
  /** 没有工作区时省略；相对路径在这种情况下必须 fail-closed。 */
  readonly workspaceRoot?: string;
  readonly sessionId?: SessionId;
  readonly turnId?: TurnId;
  readonly toolCallId?: ToolCallId;
  /** 宿主显式授予本次执行的内部目录，Permission 不自行拼接这些路径。 */
  readonly internalPaths?: InternalPathCapabilities;
}

// 一次待裁决操作的完整快照
export interface PermissionRequest {
  readonly tool: PermissionToolIdentity;
  /** 必须是 ToolExecution 完成 Schema 解析后、随后交给 execute 的同一份输入。 */
  readonly input: unknown;
  readonly intent: PermissionIntent;
  readonly context: PermissionContext;
}

export type PermissionDecisionReason =
  | { readonly type: 'invalidRequest'; readonly reason: string }
  | { readonly type: 'pathSafety'; readonly reason: string }
  | { readonly type: 'rule'; readonly rules: readonly PermissionRule[] }
  | { readonly type: 'mode'; readonly mode: PermissionMode }
  | { readonly type: 'sessionGrant'; readonly sessionId: SessionId }
  | { readonly type: 'workspace' }
  | { readonly type: 'internalPath' }
  | { readonly type: 'internalCapability'; readonly capability: InternalPathCapability }
  | { readonly type: 'promptPolicy'; readonly policy: PermissionPromptPolicy }
  | { readonly type: 'user'; readonly action: PermissionResponse['action'] }
  | { readonly type: 'headless' }
  | { readonly type: 'requestChanged' };

/** PermissionEngine 最终的裁决结果。
 * 返回结果以及处于的阶段
 */
export type PermissionDecision =
  | {
      readonly outcome: 'allow';
      readonly reason: PermissionDecisionReason;
    }
  | {
      readonly outcome: 'deny';
      readonly message: string;
      readonly reason: PermissionDecisionReason;
    };


/** 批准界面唯一需要理解的 Permission 投影。 */
export interface PermissionPrompt {
  readonly toolId: string;
  readonly toolName: string;
  readonly toolDescription?: string;
  readonly input: unknown;
  readonly riskLevel: RiskLevel;
  readonly accessType: AccessType;
  readonly targets: readonly PermissionPathTarget[];
  readonly gateReason?: string;
  readonly sessionId?: SessionId;
  readonly turnId?: TurnId;
  readonly toolCallId?: ToolCallId;
}

/** LocalHost 暂存的待批准快照；Promise、计时器和内部指纹不进入事件协议。 */
export interface PendingPermissionPrompt {
  readonly promptId: string;
  readonly createdAt: number;
  readonly prompt: PermissionPrompt;
}

export type PermissionResponse =
  | { readonly action: 'allow' }
  | { readonly action: 'allowSession' }
  | { readonly action: 'deny'; readonly reason?: string };

export type AskPermissionFn = (prompt: PermissionPrompt) => Promise<PermissionResponse>;

export interface PermissionAuthorizer {
  authorize(request: PermissionRequest, ask?: AskPermissionFn): Promise<PermissionDecision>;
  clearSession(sessionId: SessionId): void;
}

export interface PermissionRuleCatalog {
  listRules(): readonly PersistedPermissionRule[];
  saveRule(rule: PermissionRule): PersistedPermissionRule;
  setRuleEnabled(ruleId: string, enabled: boolean): boolean;
  removeRule(ruleId: string): boolean;
}

export interface PermissionEngineOptions {
  /** 代码内置的不可删除规则，例如禁止访问操作系统危险设备。 */
  readonly builtinRules?: readonly PermissionRule[];
  /** 正式构建保持 false；只有明确的开发入口可以启用 bypassPermissions。 */
  readonly allowBypassPermissions?: boolean;
}

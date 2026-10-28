export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export type PermissionUserAction = 'allow' | 'allowSession' | 'deny';

export type PermissionRuleFrom = 'userSettings' | 'projectSettings' | 'session';

export interface PermissionRuleKey {
  readonly toolName: string;
  // 未填写时匹配整个工具. 填写时由文件, 命令或网页检查解释条件.
  readonly condition?: string;
}

export interface PermissionRule {
  readonly key: PermissionRuleKey;
  readonly decision: PermissionDecision;
  readonly from: PermissionRuleFrom;
}

export interface SessionPermissionApproval {
  readonly key: PermissionRuleKey;
  // 确认界面向用户说明这次批准以后覆盖哪些操作.
  readonly description: string;
}

export type PermissionCheckResult =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly message: string }
  | {
      readonly decision: 'ask';
      readonly message: string;
      // 未提供时只能允许或拒绝本次请求, 不生成默认批准范围.
      readonly sessionApproval?: SessionPermissionApproval;
    };

export interface PermissionContext {
  readonly sessionId: string;
  readonly mode: PermissionMode;
  readonly workspaceRoots: readonly string[];
  // 用户和项目规则在 Turn 准备时读取. Session 批准由 Permission 每次检查时读取.
  readonly rules: readonly PermissionRule[];
}

export interface FilePermissionCheck {
  readonly kind: 'file';
  readonly operation: 'read' | 'write';
  readonly path: string;
  // path 表示需检查实际目标是文件还是目录. 网络路径不会为此访问文件系统.
  readonly target: 'file' | 'directory' | 'path';
  // 相对路径规则的基准目录. 未提供时不匹配相对规则.
  readonly cwd?: string;
  // 由宿主提供的内部读取目录, 如 WebFetch 的下载目录. 仍检查真实路径和用户规则.
  readonly internalReadDirectories?: readonly string[];
}

export interface ShellPermissionCheck {
  readonly kind: 'shell';
  readonly command: string;
  readonly subcommands: readonly string[];
  // 解析不完整或含动态语法时为 false, 不能靠部分子命令放行完整命令.
  readonly canMatchSubcommands: boolean;
}

// Tool 只提供操作信息, 不读取规则或决定优先顺序. 工具名由调用入口统一传入.
export type ToolPermissionCheck =
  | {
      readonly kind: 'tool';
      // 仅在规则和模式都没有决定时使用, 不是直接批准本次调用.
      readonly defaultDecision: 'allow' | 'ask';
      readonly message?: string;
      // 只有工具明确选择时才提供会话批准, 不默认记住所有输入.
      readonly sessionApproval?: 'tool' | 'input';
    }
  | FilePermissionCheck
  | ShellPermissionCheck
  | { readonly kind: 'webFetch'; readonly url: string }
  | {
      readonly kind: 'webSearch';
      readonly query: string;
      readonly allowedDomains?: readonly string[];
      readonly blockedDomains?: readonly string[];
    }
  | { readonly kind: 'mcp'; readonly reportedDestructive: boolean }
  | {
      readonly kind: 'computerUse';
      // 首次启动为 true. 后续操作由 ComputerUse 检查实际归属和状态, 不重复询问.
      readonly needsStartupApproval: boolean;
    };

export interface PermissionCheckableTool<TInput, TContext> {
  readonly name: string;
  checkPermissions(input: TInput, context: TContext): Promise<ToolPermissionCheck>;
}

// 身份用于找到唯一的等待调用. 子代理的两个身份必须一起出现.
export type PermissionRequest = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly summary?: string;
  readonly input: unknown;
  readonly message: string;
  // 只把范围说明交给前端. 保存用的 key 留在后端等待函数中.
  readonly sessionApprovalDescription?: string;
} & (
  | { readonly subagentId?: never; readonly runId?: never }
  | { readonly subagentId: string; readonly runId: string }
);

export interface PendingPermissionRequest {
  readonly toolCallId: string;
  readonly createdAt: number;
  readonly request: PermissionRequest;
}

export type PermissionUserResponse =
  | { readonly action: 'allow' }
  | { readonly action: 'allowSession' }
  | { readonly action: 'deny'; readonly reason?: string };

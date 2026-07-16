// 这里放 Permission 模块用到的基础类型和接口。

// ── Platform ──────────────────────────────────────────────────────────────────

export type Platform = 'windows' | 'wsl' | 'linux' | 'macos'

// ── Permission Modes ──────────────────────────────────────────────────────────

/**
 * ask    — prompt user for every unapproved call (default)
 * auto   — auto-allow workspace/low-risk ops; ask for dangerous or outside workspace
 * bypass — skip all permission checks (dev/test only)
 */
export type PermissionMode = 'ask' | 'auto' | 'bypass'

// ── Rule Scopes ───────────────────────────────────────────────────────────────

/** session → in-memory only | project → .ema-agent/settings.json | global → ~/.ema-agent/settings.json */
export type RuleScope = 'session' | 'project' | 'global'

// ── Risk & Access ─────────────────────────────────────────────────────────────

export type RiskLevel  = 'low' | 'medium' | 'high'
export type AccessType = 'read' | 'write' | 'execute'

/** Permission 可识别的内部目录能力；目录值必须由 Core 的 RuntimePaths 生成。 */
export interface InternalPathCapabilities {
  /** 当前 Turn 的临时 scratchpad，主 Agent 与其子 Agent 可共享。 */
  turnScratchpad?: string
}

export type InternalPathCapability = keyof InternalPathCapabilities

// ── Rules ─────────────────────────────────────────────────────────────────────

/**
 * Pattern format for pathGlob (gitignore-compatible via `ignore` library):
 *   //abs/path/**  → anchored to filesystem root
 *   ~/rel/**       → anchored to home directory
 *   /rel/**        → anchored to scope root (workspaceRoot for session/project, ~ for global)
 *   rel/**         → relative, matched against scope root
 */
export interface PermissionRule {
  /** allow = always allow | deny = always deny | ask = always prompt, even in auto mode */
  action:    'allow' | 'deny' | 'ask'
  /** Tool name to match, or '*' for all tools. */
  tool:      string
  /** Gitignore-style path pattern. Absent = match all paths for this tool. */
  pathGlob?: string
  scope:     RuleScope
  /** scope=session 时必须提供；缺失时规则按 fail-closed 原则永不匹配。 */
  sessionId?: string
}

// ── Decision Reason ───────────────────────────────────────────────────────────

/** Structured explanation of why a permission outcome was reached. */
export type DecisionReason =
  | { type: 'rule';         rule: PermissionRule }
  | { type: 'mode';         mode: PermissionMode }
  | { type: 'sessionGrant'; sessionId: string }
  | { type: 'workingDir' }
  | { type: 'internalPath'; path: string }
  | { type: 'internalCapability'; capability: InternalPathCapability; root: string }
  | { type: 'safetyCheck';  reason: string }
  | { type: 'other';        reason: string }

// ── Outcome ───────────────────────────────────────────────────────────────────

export type PermissionOutcome =
  | { granted: true;  decisionReason?: DecisionReason }
  | { granted: false; reason: string;          decisionReason?: DecisionReason }

// ── Context ───────────────────────────────────────────────────────────────────

/** Runtime context passed to every gate() call. */
export interface PermissionContext {
  /** The workspace root the agent is allowed to operate in. Empty string = no workspace (subagent). */
  workspaceRoot:   string
  /** Current session ID — used for internal path carve-outs (e.g. session memory). */
  sessionId?:      string
  /** 当前 Turn 标识，用于把并发审批精确关联到产生它的事件流。 */
  turnId?:         string
  /** 当前工具调用标识；同一 Turn 内同名工具并发时不能依赖工具名猜测。 */
  toolCallId?:     string
  /** Core 显式授予本次执行的内部目录；Permission 禁止自行拼接或猜测这些路径。 */
  internalPaths?:  InternalPathCapabilities
  /**
   * Per-call askPermission override. When set, takes precedence over
   * `PermissionConfig.ask`. AgentEngine injects this so each turn can route
   * the prompt through its own SSE event stream (see gateWithEvents helper).
   */
  ask?:                   AskPermissionFn
}

// ── Ask flow ──────────────────────────────────────────────────────────────────

/**
 * Everything the UI needs to render the permission dialog.
 * Sent engine → UI when a tool call requires user confirmation.
 */
export interface PermissionPrompt {
  toolName:         string
  toolDescription?: string
  input:            unknown
  riskLevel:        RiskLevel
  accessType?:      AccessType
  /** Human-readable reason why this call is being gated (shown in the dialog). */
  gateReason?:      string
  sessionId?:       string
  turnId?:          string
  toolCallId?:      string
}

export type PermissionResponse =
  /** Allow this one call. */
  | { action: 'allow' }
  /** Allow this tool for the rest of this session (session-scoped allow rule). */
  | { action: 'allow_session' }
  /** Deny this call. User may optionally provide a reason. */
  | { action: 'deny'; reason?: string }

export type AskPermissionFn = (prompt: PermissionPrompt) => Promise<PermissionResponse>

// ── Per-tool metadata ─────────────────────────────────────────────────────────

export interface ToolPermissionMeta {
  riskLevel:     RiskLevel
  accessType?:   AccessType
  /**
   * When true, the tool's safetyCheck runs before any allow logic and its
   * result cannot be overridden by bypass mode.
   */
  bypassImmune?: boolean
  safetyCheck?:  (input: unknown) => 'deny' | 'continue'
  /** Extracts the primary file-system path from the tool's input, if any. */
  extractPath?:  (input: unknown) => string | undefined
  /** 工具封装并隐藏真实路径时，用该字段声明它运行所需的内部目录能力。 */
  internalPathCapability?: InternalPathCapability
}

// ── Engine config ─────────────────────────────────────────────────────────────

export interface PermissionConfig {
  mode:             PermissionMode
  rules:            PermissionRule[]
  ask?:             AskPermissionFn
  onRulePersisted?: (rule: PermissionRule) => void | Promise<void>
}

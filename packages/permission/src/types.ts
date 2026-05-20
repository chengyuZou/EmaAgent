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
}

// ── Decision Reason ───────────────────────────────────────────────────────────

/** Structured explanation of why a permission outcome was reached. */
export type DecisionReason =
  | { type: 'rule';         rule: PermissionRule }
  | { type: 'mode';         mode: PermissionMode }
  | { type: 'workingDir' }
  | { type: 'internalPath'; path: string }
  | { type: 'safetyCheck';  reason: string }
  | { type: 'other';        reason: string }

// ── Permission Updates (suggestions) ─────────────────────────────────────────

/**
 * Suggested rule changes to show the user in the permission dialog so they can
 * click "Always allow" and get a meaningful rule added automatically.
 */
export type PermissionUpdate =
  | {
      type:        'addRules'
      rules:       Array<{ tool: string; pathGlob?: string; action: 'allow' | 'deny' }>
      destination: RuleScope
    }
  | { type: 'setMode';        mode: PermissionMode; destination: RuleScope }
  | { type: 'addDirectories'; directories: string[];  destination: RuleScope }

// ── Outcome ───────────────────────────────────────────────────────────────────

export type PermissionOutcome =
  | { granted: true;  updatedInput?: unknown;  decisionReason?: DecisionReason }
  | { granted: false; reason: string;          decisionReason?: DecisionReason }

// ── Context ───────────────────────────────────────────────────────────────────

/** Runtime context passed to every gate() call. */
export interface PermissionContext {
  /** Absolute path to the user's workspace/project root. */
  workspaceRoot:          string
  /** Additional directories the agent is allowed to operate in. */
  additionalWorkingDirs?: string[]
  /** Current session ID — used for internal path carve-outs (e.g. session memory). */
  sessionId?:             string
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
  /** Suggested rule changes to show as quick-action buttons in the dialog. */
  suggestions?:     PermissionUpdate[]
}

export type PermissionResponse =
  /** Allow this one call. */
  | { action: 'allow' }
  /** Allow ALL tools for the rest of this session without asking again. */
  | { action: 'allow_session' }
  /** Permanently allow this tool (persist rule at given scope). */
  | { action: 'always_allow'; scope: RuleScope }
  /** Permanently deny this tool (persist rule at given scope). */
  | { action: 'always_deny';  scope: RuleScope }
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
}

// ── Engine config ─────────────────────────────────────────────────────────────

export interface PermissionConfig {
  mode:             PermissionMode
  rules:            PermissionRule[]
  ask?:             AskPermissionFn
  onRulePersisted?: (rule: PermissionRule) => void | Promise<void>
}

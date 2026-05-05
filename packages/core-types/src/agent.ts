/**
 * Agent 模式核心类型 — 认知循环（Plan → Think → Act → Debug → Reflect）状态机定义。
 *
 * ## 三种策略
 *
 * | 策略    | 走哪些阶段                              | 工具权限            |
 * |---------|----------------------------------------|--------------------|
 * | `plan`  | Plan → Reflect                         | 无（纯推理）        |
 * | `debug` | Think → Act(只读) → Debug → Reflect    | 只读工具            |
 * | `full`  | Plan → Think → Act → Debug → Reflect   | 全部工具（含写/shell）|
 *
 * ## 认知循环概要
 *
 * ```
 * Plan (分解任务、确定策略)
 *   → Think (分析当前子任务，决定具体工具调用)
 *     → Act (执行工具——低风险并发、高风险串行 + 确认)
 *       → Debug (检查结果、修复错误、重试)
 *         → Reflect (总结进展、决定继续还是结束)
 *           → Think (下一轮，或结束)
 * ```
 *
 * ## 来源
 *
 * 继承自 EmaAgent v0.4 的 think/act 双阶段模型，并扩展为五阶段认知循环。
 * v0.4 的 `react.py` 对应：`_think()` → Think 阶段，`_act()` → Act + Debug 阶段。
 */

import type {
  RequestId,
  SessionId,
  PhaseId,
  ToolCallId,
  UnixMs,
} from "./ids.js"
import type { EmaMode } from "./mode.js"

// ═══════════════════════════════════════════════════════════════
// Agent 策略
// ═══════════════════════════════════════════════════════════════

/** Agent 模式下的执行策略——决定走哪些认知阶段。 */
export type AgentStrategy = "plan" | "debug" | "full"

// ═══════════════════════════════════════════════════════════════
// 认知阶段
// ═══════════════════════════════════════════════════════════════

/**
 * Agent 认知循环的五个阶段。
 *
 * | phase     | 做什么                                                 |
 * |-----------|-------------------------------------------------------|
 * | `plan`    | 分解用户请求为子任务，确定工具策略，产出结构化计划        |
 * | `think`   | 针对当前子任务分析具体操作，产出 thought + tool_calls    |
 * | `act`     | 执行工具调用（低风险并发、高风险串行 + 权限确认）         |
 * | `debug`   | 检查工具结果，发现错误时诊断并修复，触发重试或换策略      |
 * | `reflect` | 总结本轮进展，判断任务完成度，决定继续循环还是结束        |
 */
export type AgentPhase = "plan" | "think" | "act" | "debug" | "reflect"

// ═══════════════════════════════════════════════════════════════
// 循环内部状态
// ═══════════════════════════════════════════════════════════════

/**
 * Agent 认知循环的内部状态枚举。
 *
 * ```
 * idle ──→ thinking ──→ acting ──→ thinking (循环)
 *   │                      │
 *   │                      └──→ finished
 *   └──→ error
 * ```
 */
export type AgentLoopStatus =
  | "idle"
  | "thinking"
  | "acting"
  | "finished"
  | "error"

// ═══════════════════════════════════════════════════════════════
// 风险级别 — tool & permission 包的共享契约
// ═══════════════════════════════════════════════════════════════

/**
 * Agent 工具的风险级别。
 *
 * ## 分级规则（来自 v0.4 `constants/agent.py`）
 *
 * | 级别      | 含义                         | 示例工具                      | 默认行为        |
 * |-----------|-----------------------------|------------------------------|-----------------|
 * | `low`     | 纯读取、无副作用               | search, read_file, list_dir  | 自动执行        |
 * | `medium`  | 读取 + 有限计算                | analyze_document, web_fetch  | 自动执行        |
 * | `high`    | 写入文件、执行代码             | write_file, run_command      | 需用户确认      |
 * | `critical`| 系统级操作、网络外发           | rm -rf, sudo, curl to unknown| 需用户确认 + 警告|
 */
export type AgentRiskLevel = "low" | "medium" | "high" | "critical"

// ═══════════════════════════════════════════════════════════════
// 工具意图与结果
// ═══════════════════════════════════════════════════════════════

/**
 * LLM 输出的单条工具调用意图。
 *
 * 与 Claude Code 的 ToolIntent 对应：`{ tool, args }` 结构。
 * EmaAgent 额外携带 `toolCallId` 和 `defaultRisk` 预标注。
 */
export interface ToolIntent {
  toolCallId: ToolCallId
  toolName: string
  /** 完整参数对象（非 JSON 字符串、非增量片段）。 */
  args: Record<string, unknown>
  /** 工具注册时的预设风险级别（权限引擎会结合 args 再细分）。 */
  defaultRisk: AgentRiskLevel
}

/**
 * 工具执行结果——act 阶段的原子产出。
 */
export interface AgentToolResult {
  toolCallId: ToolCallId
  toolName: string
  success: boolean
  /** 人类可读的字符串结果（截断后的预览，完整内容走 artifact）。 */
  output: string
  errorText?: string
  durationMs: number
}

// ═══════════════════════════════════════════════════════════════
// 风险分类
// ═══════════════════════════════════════════════════════════════

/** 工具调用的风险分类结果——由 `RiskClassifier` 产出。 */
export interface RiskClassification {
  risk: AgentRiskLevel
  needConfirm: boolean
  reason: string
}

// ═══════════════════════════════════════════════════════════════
// Agent 循环运行时状态
// ═══════════════════════════════════════════════════════════════

/**
 * Agent 认知循环的完整运行时状态。
 *
 * ## 生命周期
 *
 * 1. 初始化：`{ status: "idle", iteration: 0, currentThought: "", strategy: "full", ... }`
 * 2. plan（仅 full 策略）：分解任务，产出子任务列表
 * 3. think 阶段：`status` 变为 `"thinking"`，LLM 返回 `currentThought` + `currentToolCalls`
 * 4. act 阶段：`status` 变为 `"acting"`，执行工具调用，追加到 `toolResults`
 * 5. debug 阶段：检查结果，发现错误时尝试修复或重试
 * 6. reflect 阶段：总结进展，判断是否完成
 * 7. 循环回到 think 或结束：`status` 变为 `"finished"` 或 `"error"`
 *
 * 此状态不持久化——它是内存级对象，turn 结束后即销毁。
 */
export interface AgentLoopState {
  sessionId: SessionId
  requestId: RequestId
  mode: EmaMode

  /** 本轮使用的执行策略。 */
  strategy: AgentStrategy

  /** 原始用户输入。 */
  userInput: string

  /** 当前是第几次循环迭代（从 1 开始）。 */
  iteration: number
  /** 最大允许迭代次数，超过则强制结束。 */
  maxIterations: number

  /** 最近一次 think 产出的推理文本。 */
  currentThought: string
  /** 最近一次 think 产出的工具调用列表——空数组表示无工具调用。 */
  currentToolCalls: ToolIntent[]
  /** 本轮所有已执行的工具结果（按执行顺序）。 */
  toolResults: AgentToolResult[]
  /** Plan 阶段产出的子任务列表（仅 full 策略）。 */
  planTasks: string[]
  /** 最终回复文本——仅 status=finished 时有效。 */
  finalAnswer: string

  status: AgentLoopStatus
  /** status=error 时的错误描述。 */
  error?: string

  startedAt: UnixMs
  endedAt?: UnixMs
}

// ═══════════════════════════════════════════════════════════════
// 执行追踪（前端时间线渲染用）
// ═══════════════════════════════════════════════════════════════

/** 前端时间线中单个阶段的视图。 */
export interface AgentPhaseView {
  id: PhaseId
  requestId: RequestId
  /** 当前所处的认知阶段。 */
  phase: AgentPhase
  /** 阶段标题——前端在时间线节点上直接展示。 */
  title: string
  /** 阶段状态。 */
  status: "running" | "completed" | "failed" | "skipped"
  /** 详细信息——前端悬停时展开。 */
  detail?: string
  /** 该阶段产出的 artifact ID 列表。 */
  artifactIds?: string[]
  startedAt: UnixMs
  endedAt?: UnixMs
}

// ═══════════════════════════════════════════════════════════════
// 熔断保护（来自 v0.4 `react.py:_check_repeated_error_limit`）
// ═══════════════════════════════════════════════════════════════

/**
 * 重复错误熔断器的状态——检测 Agent 是否陷入死循环。
 *
 * 每次工具调用失败后，将 `(toolName, errorText)` 哈希为 signature。
 * 若连续 `REPEATED_ERROR_LIMIT`（默认 3）次签名相同，触发熔断：
 * Agent 终止执行并返回 fallback 消息，避免无限消耗 token。
 */
export interface ErrorGuardState {
  /** 上一次错误的规范化签名（`toolName:errorText` 截断版）。 */
  lastSignature?: string
  /** 连续相同签名的次数。 */
  count: number
}

// ═══════════════════════════════════════════════════════════════
// 持久化实体（storage-sql 表行投影）
// ═══════════════════════════════════════════════════════════════

/** 权限授予持久化行——`permission_grants` 表。 */
export interface PermissionGrantRecord {
  id: string
  sessionId: SessionId
  toolName: string
  decision: "allow" | "deny"
  scope: "once" | "session" | "always"
  risk: string
  pathPattern?: string
  decidedAt: UnixMs
  expiresAt?: UnixMs
}

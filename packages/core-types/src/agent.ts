/**
 * Agent 模式核心类型 — ReAct think→act 循环的状态机定义。
 *
 * ## 架构来源
 *
 * 本文件的类型直接继承自 EmaAgent v0.4 的 `agent/react.py` 和
 * `agent/runtime_types.py`，并针对 TypeScript 的全栈类型安全做了适配。
 *
 * ## ReAct 循环概要
 *
 * ```
 * idle → thinking (LLM 返回 thought + tool_calls)
 *      → acting   (按风险分批执行工具)
 *        ├─ readonly 工具 → 并发执行 (asyncio.gather)
 *        └─ dangerous 工具 → 串行执行 (逐个确认)
 *      → thinking (下一轮，直到 FINISHED 或 maxSteps)
 *      → finished | error
 * ```
 *
 * ## 与 Claude Code 的关键差异
 *
 * Claude Code 依赖 API 原生 `tool_use` 并行块，tool 执行和 LLM 流式输出交织。
 * EmaAgent 采用严格的 think→act 两阶段：
 * 1. think：完整收集 LLM 响应（含全部 tool_calls），不边想边做
 * 2. act：按风险分类后分批执行，低风险并发、高风险串行
 *
 * 代价：牺牲了流式交织的体验。
 * 收益：跨 provider 兼容（OpenAI / DeepSeek / Ollama），权限拦截点更清晰。
 */

import type {
  RequestId,
  SessionId,
  StepId,
  ToolCallId,
  UnixMs,
} from "./ids.js"
import type { EmaMode } from "./mode.js"

// ═══════════════════════════════════════════════════════════════
// 风险级别 — tool & permission 包的共享契约
// ═══════════════════════════════════════════════════════════════

/**
 * Agent 工具的风险级别。
 *
 * ## 分级规则（来自 v0.4 `constants/agent.py`）
 *
 * | 级别      | 含义                         | 示例工具                      | 默认行为        |
 * |-----------|------------------------------|------------------------------|-----------------|
 * | `low`     | 纯读取、无副作用               | search, read_file, list_dir  | 自动执行        |
 * | `medium`  | 读取 + 有限计算                | analyze_document, web_fetch  | 自动执行        |
 * | `high`    | 写入文件、执行代码             | write_file, run_command      | 需用户确认      |
 * | `critical`| 系统级操作、网络外发           | rm -rf, sudo, curl to unknown| 需用户确认 + 警告|
 *
 * ## 与 PermissionRisk 的关系
 *
 * `AgentRiskLevel` 和 `PermissionRisk`（permission 包）是同一个概念的两种表达：
 * - `AgentRiskLevel`：从工具能力角度描述"这个工具有多危险"
 * - `PermissionRisk`：从权限决策角度描述"这个操作需要多严格的审批"
 *
 * 两者值域相同，可以互相赋值。统一在此定义，避免 tool 和 permission 包各定义一套。
 */
export type AgentRiskLevel = "low" | "medium" | "high" | "critical"

// ═══════════════════════════════════════════════════════════════
// ReAct 状态机
// ═══════════════════════════════════════════════════════════════

/**
 * ReAct 循环的状态枚举。
 *
 * ```
 * idle ──→ thinking ──→ acting ──→ thinking (循环)
 *   │                      │
 *   │                      └──→ finished
 *   └──→ error
 * ```
 */
export type ReActStatus =
  | "idle"       // 初始/等待
  | "thinking"   // LLM 推理中（think 阶段）
  | "acting"     // 工具执行中（act 阶段）
  | "finished"   // 正常结束
  | "error"      // 异常终止

/**
 * ReAct 单步的类型标签——对应 `step_start` / `step_end` SSE 事件的 stepType。
 *
 * | stepType         | 阶段   | 含义                                 |
 * |------------------|--------|--------------------------------------|
 * | `context`        | think  | 组装本轮上下文（召回、压缩、system prompt）|
 * | `thinking`       | think  | LLM 推理，生成 thought + tool_calls   |
 * | `tool`           | act    | 执行工具调用（单个或并行批次）          |
 * | `diff`           | act    | 生成/应用代码差异                      |
 * | `artifact`       | act    | 创建结构化产物（文件、图表、表格）       |
 * | `response`       | think  | 生成最终用户回复                       |
 * | `narrative_recall`| think | 查询 Narrative 剧情记忆               |
 */
export type ReActStepType =
  | "context"
  | "thinking"
  | "tool"
  | "diff"
  | "artifact"
  | "response"
  | "narrative_recall"

// ═══════════════════════════════════════════════════════════════
// 工具意图与结果
// ═══════════════════════════════════════════════════════════════

/**
 * LLM 输出的单条工具调用意图。
 *
 * ## 与 ToolCallChunk 的区别
 *
 * `ToolCallChunk`（model.ts）是底层 LLM 协议的流式片段（argsDelta 增量）。
 * `ToolIntent` 是解析完整后的结构化意图，供 PermissionEngine 和 ToolRegistry 消费。
 *
 * ## 与 Claude Code ToolIntent 的对应
 *
 * Claude Code 的 Tool 系统也使用 `{ tool, args }` 结构。
 * EmaAgent 额外携带 `toolCallId` 和 `risk` 预标注，减少后续查找。
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
export interface ReActToolResult {
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

/**
 * 工具调用的风险分类结果——由 `RiskClassifier` 产出。
 *
 * ## 分类逻辑（来自 v0.4 `react.py:_is_read_only_tool_call`）
 *
 * 1. 工具名在 `READ_ONLY_TOOL_NAMES` 中 → risk=low, needConfirm=false
 * 2. 工具名在 `DANGEROUS_TOOL_NAMES` 中（run_terminal, execute_code）
 *    → risk=high/critical, needConfirm=true
 * 3. file_operations 按 operation 细分：
 *    read/list → low, delete/move/copy/rename → high
 * 4. 其余 → risk=medium, needConfirm=false（可配置）
 */
export interface RiskClassification {
  /** 分级后的风险级别。 */
  risk: AgentRiskLevel
  /** 是否需要用户确认后才能执行。 */
  needConfirm: boolean
  /** 人类可读的理由——用于前端确认对话框。 */
  reason: string
}

// ═══════════════════════════════════════════════════════════════
// ReAct 运行时状态
// ═══════════════════════════════════════════════════════════════

/**
 * ReAct think→act 循环的完整运行时状态。
 *
 * ## 生命周期
 *
 * 1. 初始化：`{ status: "idle", currentStep: 0, currentThought: "", ... }`
 * 2. think 阶段：`status` 变为 `"thinking"`，LLM 返回 `currentThought` + `currentToolCalls`
 * 3. act 阶段：`status` 变为 `"acting"`，逐个执行 `currentToolCalls`，追加到 `toolResults`
 * 4. 循环回到 think 或结束：`status` 变为 `"finished"` 或 `"error"`
 *
 * 此状态不持久化——它是内存级对象，turn 结束后即销毁。
 * 持久化的 turn 记录使用 `TurnRecord`（turn.ts）。
 */
export interface ReActState {
  sessionId: SessionId
  requestId: RequestId
  mode: EmaMode

  /** 原始用户输入（未被 context 改写）。 */
  userInput: string

  /** 当前是第几步（从 1 开始）。 */
  currentStep: number
  /** 最大允许步数，超过则强制结束。 */
  maxSteps: number

  /** 最近一次 think 产出的推理文本。 */
  currentThought: string
  /** 最近一次 think 产出的工具调用列表——空数组表示无工具调用。 */
  currentToolCalls: ToolIntent[]
  /** 本轮所有已执行的工具结果（按执行顺序）。 */
  toolResults: ReActToolResult[]
  /** 最终回复文本——仅 status=finished 时有效。 */
  finalAnswer: string

  status: ReActStatus
  /** status=error 时的错误描述。 */
  error?: string

  startedAt: UnixMs
  endedAt?: UnixMs
}

// ═══════════════════════════════════════════════════════════════
// 执行追踪（前端时间线渲染用）
// ═══════════════════════════════════════════════════════════════

/** 前端时间线中单个步骤的状态。 */
export interface ExecutionStepView {
  id: StepId
  requestId: RequestId
  stepType: ReActStepType
  /** 步骤标题——前端在时间线节点上直接展示。 */
  title: string
  /** 步骤状态。 */
  status: "running" | "completed" | "failed" | "skipped"
  /** 详细信息——前端悬停时展开。 */
  detail?: string
  /** 该步骤产出的 artifact ID 列表。 */
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
 * ## 工作方式
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

/** 熔断常量。 */
export const REPEATED_ERROR_LIMIT = 3
/** ReAct 循环默认最大步数。 */
export const DEFAULT_REACT_MAX_STEPS = 20

// ═══════════════════════════════════════════════════════════════
// v0.4 工具分类常量（TypeScript 版本）
// ═══════════════════════════════════════════════════════════════

/**
 * 无需用户确认的只读工具集合——这些工具不修改系统状态。
 *
 * 来自 v0.4 `constants/agent.py:READ_ONLY_TOOL_NAMES`，
 * 在 `RiskClassifier` 实现中用于 `_is_read_only_tool_call()` 逻辑。
 */
export const READ_ONLY_TOOL_PATTERNS = [
  "search_text",       // v0.4: baidu_search
  "read_file",         // v0.4: file_operations[read]
  "list_dir",          // v0.4: file_operations[list]
  "analyze_document",  // v0.4: analyze_document
  "analyze_code",      // v0.4: analyze_code
  "get_weather",       // v0.4: get_weather
  "get_current_time",  // v0.4: get_current_time
  "read_webpage",      // v0.4: read_webpage
  "arxiv_paper",       // v0.4: arxiv_paper
] as const

/**
 * 高风险工具名称——执行前必须获得用户确认。
 *
 * 来自 v0.4 `constants/agent.py:DANGEROUS_TOOL_NAMES`。
 */
export const DANGEROUS_TOOL_NAMES = [
  "run_command",   // v0.4: run_terminal
  "run_python",    // v0.4: execute_code
  "write_file",    // v0.4: file_operations[write]（通过 operation 细分）
] as const

/**
 * 文件操作中需要确认的操作类型。
 *
 * 来自 v0.4 `constants/agent.py:DANGEROUS_FILE_OPERATIONS`。
 * 注意：file_operations 工具自身不是 always dangerous，
 * read/list 是安全的——危险的是 delete/move/copy/rename 操作。
 */
export const DANGEROUS_FILE_OPERATIONS = [
  "delete",
  "move",
  "copy",
  "rename",
  "write",
] as const

/** 只读工具的最大并发数（Semaphore 限流）。 */
export const MAX_PARALLEL_READONLY_TOOLS = 3

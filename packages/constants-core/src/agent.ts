/**
 * Agent 模式常量 — 认知循环、风险分级、工具分类。
 *
 * 来源：EmaAgent v0.4 `constants/agent.py` + Plan/Think/Act/Debug/Reflect 五阶段模型。
 * 所有 Agent 循环和权限管线的硬编码阈值集中于此。
 */

import type { AgentRiskLevel, AgentLoopStatus, AgentPhase, AgentStrategy } from "@ema-agent/core-types"

// ═══════════════════════════════════════════════════════════════
// 熔断 & 循环限制（来自 v0.4 `react.py`）
// ═══════════════════════════════════════════════════════════════

/** 连续同一错误触发熔断的阈值。 */
export const REPEATED_ERROR_LIMIT = 3

/** 认知循环默认最大迭代次数。 */
export const DEFAULT_MAX_ITERATIONS = 15

/** 只读工具的最大并发数（Semaphore 限流）。 */
export const MAX_PARALLEL_READONLY_TOOLS = 3

// ═══════════════════════════════════════════════════════════════
// 工具分类（来自 v0.4 `constants/agent.py`）
// ═══════════════════════════════════════════════════════════════

/** 无需用户确认的只读工具名称——这些工具不修改系统状态。 */
export const READ_ONLY_TOOL_PATTERNS = [
  "search_text",
  "read_file",
  "list_dir",
  "analyze_document",
  "analyze_code",
  "get_weather",
  "get_current_time",
  "read_webpage",
  "arxiv_paper",
  "analyze_image",
  "analyze_audio",
  "transcribe_audio",
  "search_image",
  "capture_screenshot",
] as const

/** 高风险工具名称——执行前必须获得用户确认。 */
export const DANGEROUS_TOOL_NAMES = [
  "run_command",
  "run_python",
  "write_file",
  "generate_speech",
  "generate_image",
  "upload_file",
  "record_audio",
] as const

/** 文件操作中需要确认的操作类型。 */
export const DANGEROUS_FILE_OPERATIONS = [
  "delete",
  "move",
  "copy",
  "rename",
  "write",
] as const

// ═══════════════════════════════════════════════════════════════
// 策略 & 阶段 & 风险级别枚举
// ═══════════════════════════════════════════════════════════════

/** Agent 执行策略全集。 */
export const AGENT_STRATEGIES = ["plan", "debug", "full"] as const satisfies readonly AgentStrategy[]

/** 认知五阶段全集。 */
export const AGENT_PHASES = ["plan", "think", "act", "debug", "reflect"] as const satisfies readonly AgentPhase[]

/** 全部风险级别（升序）。 */
export const AGENT_RISK_LEVELS = ["low", "medium", "high", "critical"] as const satisfies readonly AgentRiskLevel[]

/** Agent 认知循环内部状态全集。 */
export const AGENT_LOOP_STATUSES = ["idle", "thinking", "acting", "finished", "error"] as const satisfies readonly AgentLoopStatus[]

// ═══════════════════════════════════════════════════════════════
// 工具注册
// ═══════════════════════════════════════════════════════════════

/** 内置工具名称全集——ToolRegistry 注册和 BuiltinToolExecutor 分发用。 */
export const BUILTIN_TOOL_NAMES = [
  "read_file",
  "list_dir",
  "search_text",
  "write_file",
  "run_command",
  "run_python",
  "web_fetch",
  "web_search",
  "generate_image",
  "generate_speech",
  "transcribe_audio",
  "analyze_image",
] as const

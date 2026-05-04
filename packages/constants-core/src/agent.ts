/**
 * Agent 模式常量 — ReAct 循环、风险分级、工具分类。
 *
 * 来源：EmaAgent v0.4 `constants/agent.py` + CLAUDE.md 架构红线。
 * 所有 ReAct 循环和权限管线的硬编码阈值集中于此。
 *
 * 与 core-types 绑定的常量（如工具分类列表、熔断阈值）直接从
 * `@ema-agent/core-types` 导入并重导出，本文件不重复定义。
 */

import type { AgentRiskLevel, ReActStatus, ReActStepType } from "@ema-agent/core-types"
import {
  REPEATED_ERROR_LIMIT,
  DEFAULT_REACT_MAX_STEPS,
  MAX_PARALLEL_READONLY_TOOLS,
  READ_ONLY_TOOL_PATTERNS,
  DANGEROUS_TOOL_NAMES,
  DANGEROUS_FILE_OPERATIONS,
} from "@ema-agent/core-types"

export {
  REPEATED_ERROR_LIMIT,
  DEFAULT_REACT_MAX_STEPS,
  MAX_PARALLEL_READONLY_TOOLS,
  READ_ONLY_TOOL_PATTERNS,
  DANGEROUS_TOOL_NAMES,
  DANGEROUS_FILE_OPERATIONS,
}

// ═══════════════════════════════════════════════════════════════
// 风险级别 & 状态枚举
// ═══════════════════════════════════════════════════════════════

/** 全部风险级别（升序）。 */
export const AGENT_RISK_LEVELS = ["low", "medium", "high", "critical"] as const satisfies readonly AgentRiskLevel[]

/** ReAct 状态机的全部合法状态。 */
export const REACT_STATUSES = ["idle", "thinking", "acting", "finished", "error"] as const satisfies readonly ReActStatus[]

/** ReAct 步骤类型全集。 */
export const REACT_STEP_TYPES = [
  "context",
  "thinking",
  "tool",
  "diff",
  "artifact",
  "response",
  "narrative_recall",
] as const satisfies readonly ReActStepType[]

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

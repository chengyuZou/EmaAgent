/**
 * Agent 循环与工具调度的不可配置常量。
 *
 * @remarks
 * 这些值是系统硬约束，禁止从外部配置覆盖，避免用户误改导致死循环。
 */

/** ReAct 风格 Agent 单轮最大思考-行动步数（含反思） */
export const AGENT_MAX_STEPS = 8;

/** 工具确认弹窗的超时时间（毫秒），超时视为拒绝 */
export const TOOL_CONFIRM_TIMEOUT_MS = 30_000;

/** 只读工具的最大并发数，写工具强制串行 */
export const MAX_PARALLEL_READONLY_TOOLS = 4;

/** 单步 LLM 调用超时（毫秒） */
export const LLM_STEP_TIMEOUT_MS = 60_000;

/** 单次工具执行超时（毫秒） */
export const TOOL_STEP_TIMEOUT_MS = 30_000;

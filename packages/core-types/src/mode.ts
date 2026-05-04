/**
 * EmaAgent 三模式定义。
 *
 * ## 核心概念
 *
 * mode 是 **turn 级别** 的执行策略，不是 session 的固定标签。
 * 同一个 session 可以连续提交 `chat → agent → narrative` 三种不同 mode 的 turn。
 *
 * 每个 mode 决定本轮 turn 的：
 * - 系统提示词选择（Ema 日常人格 vs 工具使用人格 vs 剧情导航人格）
 * - 是否启用 ReAct 工具调用循环（agent 模式）
 * - 是否查询 Narrative 剧情记忆（narrative 模式）
 */

// ═══════════════════════════════════════════════════════════════
// 核心枚举
// ═══════════════════════════════════════════════════════════════

/**
 * EmaAgent 的三种执行模式。
 *
 * | mode       | 用途             | 启用 ReAct | 查询 Narrative |
 * |------------|------------------|------------|----------------|
 * | `chat`     | 日常陪伴、闲聊    | 否         | 否             |
 * | `agent`    | 生产力工具调用     | 是         | 否             |
 * | `narrative`| 剧情检索、世界观探索| 否         | 是             |
 */
export type EmaMode = "chat" | "agent" | "narrative"

/**
 * 所有合法 mode 的只读数组——供 UI 选择器和 Zod 校验复用。
 *
 * ```ts
 * // Zod 校验
 * z.enum(EMA_MODES)
 *
 * // 前端下拉框
 * EMA_MODES.map(mode => ({ label: modeLabel(mode), value: mode }))
 * ```
 */
export const EMA_MODES = ["chat", "agent", "narrative"] as const satisfies readonly EmaMode[]

/**
 * 运行时判断未知字符串是否合法 mode。
 *
 * ```ts
 * const raw = req.body.mode
 * if (!isEmaMode(raw)) {
 *   throw new EmaError("bad_request", `非法 mode: ${raw}`)
 * }
 * // raw 类型在此处收窄为 EmaMode
 * ```
 */
export function isEmaMode(value: string): value is EmaMode {
  return (EMA_MODES as readonly string[]).includes(value)
}

// ═══════════════════════════════════════════════════════════════
// 前端 UI 辅助
// ═══════════════════════════════════════════════════════════════

/** 前端输入区 mode 选择器的状态追踪。 */
export interface ModeSelectionState {
  /** 当前输入框处于哪个 mode。 */
  current: EmaMode
  /** 该 session 上一次成功提交 turn 的 mode——用于恢复默认值。 */
  lastUsed: EmaMode
  /**
   * 本次 mode 变更的来源——用于埋点追踪和状态流转调试。
   *
   * - `session_default`: 系统自动继承上一次的 mode
   * - `user_selected`: 用户手动点击下拉框切换
   * - `retry_inherited`: 用户点击"重试"时，从历史 turn 继承的 mode
   */
  source: "session_default" | "user_selected" | "retry_inherited"
}

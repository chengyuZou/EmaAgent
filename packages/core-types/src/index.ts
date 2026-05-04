/**
 * EmaAgent Core Types — 统一导出入口。
 *
 * 消费方（前端、BFF、能力模块、仓储实现）只需要：
 * ```
 * import { ... } from "@ema-agent/core-types"
 * ```
 */

// ---- 基础类型工具 ----
export type * from "./ids.js"

// ---- 实体 ----
export type * from "./mode.js"
export type * from "./session.js"
export type * from "./message.js"
export type * from "./turn.js"
export type * from "./artifact.js"
export type * from "./attachment.js"
export type * from "./model.js"
export type * from "./multimodal.js"

// ---- 桌面通知 ----
export type * from "./notification.js"

// ---- Agent 模式 ----
export type * from "./agent.js"

// ---- 记忆系统 ----
export type * from "./memory.js"

// ---- 协议 ----
export type * from "./event.js"
export type * from "./errors.js"

// ---- 聚合视图 ----
export type * from "./view.js"

// ---- 元数据 ----
export type * from "./metadata.js"

// ═══════════════════════════════════════════════════════════════
// 运行时值（函数/常量）
// ═══════════════════════════════════════════════════════════════

// ids
export { asId } from "./ids.js"

// mode
export { EMA_MODES, isEmaMode } from "./mode.js"

// errors
export { EmaError, toUiErrorView } from "./errors.js"

// agent runtime constants → use @ema-agent/constants-core instead


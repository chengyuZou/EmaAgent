/**
 * 桌面通知类型 — Turn 生命周期的 OS 原生 Toast。
 *
 * ## 设计意图
 *
 * 与 content block 渲染同步产生，但不持久化到 SQLite。
 * 仅作为 SSE 事件流转，前端收到后通过 Tauri notification API
 * 在用户桌面右上角弹出 1 秒 toast。主打最小化后台时的自动提示。
 *
 * ## 与 Render Block 的关系
 *
 * Render Block → 渲染在 Ema 窗口内的气泡中
 * Notification → 渲染在 OS 桌面的 toast 中
 * 两者从同一事件源派生，各自消费，互不耦合。
 */

import type { RequestId, SessionId } from "./ids.js"

/** 通知语义类别——前端据此选择 icon 和颜色。 */
export type NotificationKind =
  | "tool_start"
  | "tool_done"
  | "tool_failed"
  | "rag_recall"
  | "rag_done"
  | "image_gen_start"
  | "image_gen_done"
  | "compaction"
  | "artifact_create"
  | "permission_needed"
  | "turn_completed"
  | "turn_failed"

/**
 * Turn 级别的桌面通知——不落盘，纯 SSE 内存流。
 *
 * @example
 * // BFF 在工具调用后 emit：
 * const notification: TurnNotification = {
 *   notificationId: "tc_001_done",
 *   sessionId: "ses_abc123",
 *   requestId: "req_007",
 *   title: "工具执行完成",
 *   body: "run_command: npm install 完成",
 *   kind: "tool_done",
 *   ttlMs: 1000,
 * }
 */
export interface TurnNotification {
  /** 去重标识（同 turn 内由 BFF 保证唯一）。 */
  notificationId: string
  sessionId: SessionId
  requestId: RequestId
  /** OS 通知栏第一行。 */
  title: string
  /** OS 通知栏第二行。 */
  body: string
  kind: NotificationKind
  /** 显示时长（毫秒），默认 1000。 */
  ttlMs: number
}

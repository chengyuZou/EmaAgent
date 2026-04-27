/**
 * EmaAgent V1 的三种执行模式。
 *
 * 注意：mode 是每一轮 turn 的执行策略，不是 session 的固定类型。
 * 同一个 session 可以连续提交 chat / agent / narrative 三种不同 turn。
 */

/** 用户每一轮可以选择的执行模式。 */
export type EmaMode = "chat" | "agent" | "narrative";

/** 所有合法模式，供 UI 选择器和运行时校验复用。 */
export const EMA_MODES = ["chat", "agent", "narrative"] as const satisfies readonly EmaMode[];

/** 判断未知字符串是否是合法模式。 */
export function isEmaMode(value: string): value is EmaMode {
  return (EMA_MODES as readonly string[]).includes(value);
}

/** 当前会话输入区的模式选择状态。 */
export interface ModeSelectionState {
  /** 当前输入框准备使用的模式。 */
  current: EmaMode;
  /** 该 session 上一次成功提交 turn 使用的模式，仅用于恢复默认值。 */
  lastUsed: EmaMode;
  /** 选择来源，用于调试 UI 是否误把模式当成全局路由。 */
  source: "session_default" | "user_selected" | "retry_inherited";
}

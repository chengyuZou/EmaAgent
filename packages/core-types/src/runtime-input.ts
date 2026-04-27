/**
 * 运行时输入封套：raw query 与 assembled prompt 的强隔离协议。
 *
 * @remarks
 * 这是 EmaAgent 最核心的不变式之一。
 * `rawUserQuery` 必须原样进历史，`assembledUserPrompt` 仅用于本轮 LLM 推理。
 *
 * 反例：若将 `assembledUserPrompt`（含附件召回片段）回写历史，
 * 下一轮模型会误将召回内容视为用户原话，产生"你刚才提到了xxx"的幻觉，
 * 因为历史里根本没有用户说过那些话。
 */

import type { EmaMode } from "./modes.js";

/** 运行时输入封套。 */
export interface RuntimeInputEnvelope {
  /** 用户原始输入，写入会话历史与长期记忆时只用这个字段 */
  rawUserQuery: string;
  /** 本轮实际发给模型的 user prompt（可包含召回片段提示、runtime 注入） */
  assembledUserPrompt: string;
  /** 运行时 system prompt 组装块，不写入用户消息历史 */
  runtimeSystemPrompt: string;
  /** 仅用于调试与前端可视化，不用于持久化文本回放 */
  contextBlocks: RuntimeContextBlock[];
  /** 本轮执行模式，方便 prompt builder 注入不同策略。 */
  mode?: EmaMode;
}

/** 上下文块来源 */
export type ContextBlockSource = "attachment" | "memory" | "narrative" | "vision";

/** 单个上下文块 */
export interface RuntimeContextBlock {
  /** 来源 */
  source: ContextBlockSource;
  /** 块文本内容 */
  text: string;
}

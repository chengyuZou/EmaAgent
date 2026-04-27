/**
 * 上下文窗口构建与压缩。
 *
 * @remarks
 * 当消息历史超过 token 预算时，触发压缩策略：
 * 保留最近 N 条完整消息，更早的消息压缩为摘要。
 */

import type { ChatMessage } from "@ema-agent/core-types";
import { WORKING_MEMORY_WINDOW_SIZE } from "@ema-agent/constants-core";

export const DEFAULT_CHARS_PER_TOKEN = 2.5;

/** 默认 token 估算函数 */
export function defaultEstimateTokens(text: string): number {
  return Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN);
}

/**
 * 在给定预算内构建上下文窗口。
 *
 * @param messages - 完整消息列表
 * @param budget - token 预算（字符数估算）
 * @returns 截断后的消息列表
 */
export function buildContextWindow(
  messages: ChatMessage[],
  budget: number,
  estimateTokens: (text: string) => number = defaultEstimateTokens,
): ChatMessage[] {
  if (messages.length === 0) return [];

  let usedTokens = 0;
  const result: ChatMessage[] = [];
  // 从新消息往回遍历
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const msgTokens = estimateTokens(msg.content);
    // 预算已满且至少有一条就返回
    if (usedTokens + msgTokens > budget && result.length > 0) {
      break;
    }
    usedTokens += msgTokens;
    result.unshift(msg);
  }
  return result;
}

/**
 * 压缩上下文：将超出窗口的旧消息替换为摘要。
 *
 * @param messages - 完整消息列表
 * @returns 压缩后的消息列表
 */
export function compactContext(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= WORKING_MEMORY_WINDOW_SIZE * 2) {
    return messages;
  }

  // TODO: 实现 LLM 摘要压缩
  // 保留最近 WORKING_MEMORY_WINDOW_SIZE 条，中间部分压缩为 system 摘要消息
  return messages.slice(-WORKING_MEMORY_WINDOW_SIZE * 2);
}

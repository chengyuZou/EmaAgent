// 寻找不会拆散 tool_use 与 tool_result 配对的安全压缩边界。
import type { Message as ModelMessage } from '@ema-agent/llm';

/**
 * 从 `desiredCut` 向后遍历，找到一个安全的消息边界，不会拆散 tool_use/tool_result 对。
 * Anthropic/OpenAI API 要求 tool_result 用户消息必须紧接在助手 tool_use 之后
 * 一个简单的切片可能会落在它们之间，产生一个孤立的 tool_result。
 */
export function findSafeCutPoint(messages: ModelMessage[], desiredCut: number): number {
  for (let i = desiredCut; i > 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'user' && Array.isArray(msg.content) && isAllToolResults(msg.content)) {
      continue;
    }
    if (msg.role === 'assistant' && Array.isArray(msg.content) && hasAnyToolUse(msg.content)) {
      continue;
    }
    return i;
  }
  return 0;
}

export function isAllToolResults(blocks: unknown[]): boolean {
  return blocks.length > 0 &&
    blocks.every((b) => (b as { type?: string }).type === 'tool_result');
}

export function hasAnyToolUse(blocks: unknown[]): boolean {
  return blocks.some((b) => (b as { type?: string }).type === 'tool_use');
}

export function macroFailureReason(attempts: number): string {
  if (attempts <= 0) return 'Macro compaction did not run: no compaction binding or empty compaction slice';
  return `Macro compaction failed after ${attempts} attempt(s)`;
}

// 寻找不会拆散 tool_use 与 tool_result 配对的安全压缩边界。
import type { Message as ModelMessage } from '@ema-agent/llm';

/** 从期望位置向前寻找安全边界，保证 tail 内每个 tool_result 的调用也留在 tail。 */
export function findSafeCutPoint(messages: readonly ModelMessage[], desiredCut: number): number {
  const toolUseIndexes = new Map<string, number>();
  const toolResults: Array<{ toolCallId: string; messageIndex: number }> = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const type = (block as { type?: string }).type;
      if (message.role === 'assistant' && type === 'tool_use') {
        const id = (block as { id?: string }).id;
        if (id) toolUseIndexes.set(id, messageIndex);
      }
      if (message.role === 'user' && type === 'tool_result') {
        const toolCallId = (block as { toolCallId?: string }).toolCallId;
        if (toolCallId) toolResults.push({ toolCallId, messageIndex });
      }
    }
  }

  let boundary = Math.min(Math.max(0, desiredCut), messages.length);
  while (boundary > 0) {
    let nextBoundary = boundary;
    for (const result of toolResults) {
      if (result.messageIndex < boundary) continue;
      const toolUseIndex = toolUseIndexes.get(result.toolCallId);
      // 缺失或倒序配对说明历史已经损坏，没有任何非零切点能生成合法 tail。
      if (toolUseIndex === undefined || toolUseIndex >= result.messageIndex) return 0;
      if (toolUseIndex < boundary) nextBoundary = Math.min(nextBoundary, toolUseIndex);
    }
    if (nextBoundary === boundary) return boundary;
    boundary = nextBoundary;
  }
  return 0;
}

/** 从期望位置向后寻找安全边界，供预算不足时扩大待摘要的旧历史。 */
export function findSafeCutPointAtOrAfter(
  messages: readonly ModelMessage[],
  desiredCut: number,
): number {
  const start = Math.min(Math.max(0, desiredCut), messages.length);
  for (let boundary = start; boundary <= messages.length; boundary += 1) {
    if (findSafeCutPoint(messages, boundary) === boundary) return boundary;
  }
  return messages.length;
}

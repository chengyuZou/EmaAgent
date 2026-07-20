// 清理不允许进入下一次 LLM 请求或 Compaction 摘要的 Provider 私有内容。

import type { AssistantBlock, Message as ModelMessage } from '@ema-agent/llm';

export function sanitizeCompactionMessages(messages: ModelMessage[]): ModelMessage[] {
  const sanitized: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') {
      sanitized.push(message);
      continue;
    }
    const content = message.content.filter(isReplayableAssistantBlock);
    if (content.length > 0) sanitized.push({ role: 'assistant', content });
  }
  return sanitized;
}

function isReplayableAssistantBlock(block: AssistantBlock): boolean {
  return block.type !== 'thinking';
}

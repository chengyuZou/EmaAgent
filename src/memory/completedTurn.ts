// 从已完成 Turn 提取用户可见文本，并交给长期记忆的待提取流水线。

import type { SessionStore, Turn } from '@ema-agent/session';
import { bestEffortAsync } from './best-effort.js';
import type { MemoryPlanner } from './planner.js';

/**
 * 只观察已经成功提交的 Turn。工具结果和 thinking 不属于长期记忆输入，
 * 多段正常 Assistant 消息则按产生顺序合并。
 */
export async function recordCompletedTurnMemory(
  session: SessionStore,
  planner: MemoryPlanner,
  turn: Turn,
): Promise<void> {
  await bestEffortAsync('record completed turn memory', async () => {
    const messages = session.loadMessagesForTurn(turn.id);
    const userMessage = messages.find(
      (message) => message.role === 'user' && message.kind === 'normal',
    );
    const assistantText = messages
      .filter((message) => message.role === 'assistant' && message.kind === 'normal')
      .map((message) => extractText(message.blocks))
      .filter((text) => text.length > 0)
      .join('\n\n');

    await planner.recordTurnForExtraction({
      sessionId: turn.sessionId,
      turnId: turn.id,
      executionProfile: turn.executionProfile,
      userText: extractText(userMessage?.blocks),
      assistantText,
    });
  }, undefined);
}

function extractText(blocks: unknown): string {
  if (!blocks) return '';
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const entry = block as { type?: unknown; text?: unknown };
    if (entry.type === 'text' && typeof entry.text === 'string') {
      parts.push(entry.text);
    }
  }
  return parts.join('\n');
}
